import {
	unwrapKey,
	unwrapKeyWithPassword,
	wrapKeyWithPassword,
} from "../crypto";
import { db } from "../db";
import { isResponse, json, requireAuth } from "../middleware/auth";
import { serveFile } from "./files";

const debug = process.env.DEBUG ? console.log.bind(console, "[debug]") : () => {};

export async function handleCreateLink(
	req: Request,
	fileId: string,
): Promise<Response> {
	const auth = await requireAuth(req);
	if (isResponse(auth)) return auth;

	const file = db
		.query(
			"SELECT owner_id, key_wrapped, key_iv, key_tag FROM files WHERE id = ?",
		)
		.get(fileId) as any;
	if (!file) return json({ error: "File not found" }, 404);
	if (file.owner_id !== auth.userId && auth.role !== "admin")
		return json({ error: "Forbidden" }, 403);

	const body = ((await req.json().catch(() => null)) as any) ?? {};
	const { password, expires_days, max_downloads, can_write = false } = body;

	const id = crypto.randomUUID();
	const expiresAt = expires_days
		? new Date(Date.now() + expires_days * 86400000).toISOString()
		: null;

	let passKeyWrapped: string | null = null;
	let passKeyIv: string | null = null;
	let passKeyTag: string | null = null;
	let passSalt: string | null = null;

	if (password) {
		// Derive a password-specific file key wrapping
		const fileKey = unwrapKey(file.key_wrapped, file.key_iv, file.key_tag);
		const w = wrapKeyWithPassword(fileKey, password);
		passKeyWrapped = w.wrapped;
		passKeyIv = w.iv;
		passKeyTag = w.tag;
		passSalt = w.salt;
	}

	db.query(`
    INSERT INTO share_links (id, file_id, created_by, can_write, max_downloads, expires_at,
      pass_key_wrapped, pass_key_iv, pass_key_tag, pass_salt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
		id,
		fileId,
		auth.userId,
		can_write ? 1 : 0,
		max_downloads ?? null,
		expiresAt,
		passKeyWrapped,
		passKeyIv,
		passKeyTag,
		passSalt,
	);

	const serverUrl =
		process.env.SERVER_URL || `http://localhost:${process.env.PORT || 3000}`;
	debug(`link:create id=${id} fileId=${fileId} userId=${auth.userId} password=${!!password} expires=${expiresAt} maxDownloads=${max_downloads ?? "unlimited"}`);
	return json(
		{
			id,
			url: `${serverUrl}/api/dl/${id}`,
			password_protected: !!password,
			expires_at: expiresAt,
			max_downloads: max_downloads ?? null,
		},
		201,
	);
}

export async function handleListLinks(
	req: Request,
	fileId: string,
): Promise<Response> {
	const auth = await requireAuth(req);
	if (isResponse(auth)) return auth;

	const file = db
		.query("SELECT owner_id FROM files WHERE id = ?")
		.get(fileId) as any;
	if (!file) return json({ error: "File not found" }, 404);
	if (file.owner_id !== auth.userId && auth.role !== "admin")
		return json({ error: "Forbidden" }, 403);

	const links = db
		.query(`
    SELECT id, can_write, max_downloads, downloads, expires_at,
      CASE WHEN pass_salt IS NOT NULL THEN 1 ELSE 0 END as password_protected,
      created_at
    FROM share_links WHERE file_id = ? ORDER BY created_at DESC
  `)
		.all(fileId);

	return json({ links });
}

export async function handleRevokeLink(
	req: Request,
	fileId: string,
	linkId: string,
): Promise<Response> {
	const auth = await requireAuth(req);
	if (isResponse(auth)) return auth;

	const file = db
		.query("SELECT owner_id FROM files WHERE id = ?")
		.get(fileId) as any;
	if (!file) return json({ error: "File not found" }, 404);
	if (file.owner_id !== auth.userId && auth.role !== "admin")
		return json({ error: "Forbidden" }, 403);

	db.query("DELETE FROM share_links WHERE id = ? AND file_id = ?").run(
		linkId,
		fileId,
	);
	return json({ ok: true });
}

export async function handleAccessLink(
	req: Request,
	linkId: string,
): Promise<Response> {
	const link = db
		.query(`
    SELECT sl.*, f.filename, f.size, f.mime_type, f.status, f.expires_at as file_expires_at
    FROM share_links sl JOIN files f ON f.id = sl.file_id
    WHERE sl.id = ?
  `)
		.get(linkId) as any;

	if (!link) return json({ error: "Link not found" }, 404);
	if (link.expires_at && new Date(link.expires_at) < new Date())
		return json({ error: "Link expired" }, 410);
	if (link.max_downloads !== null && link.downloads >= link.max_downloads)
		return json({ error: "Download limit reached" }, 410);
	if (link.file_expires_at && new Date(link.file_expires_at) < new Date())
		return json({ error: "File expired" }, 410);
	if (link.pass_salt && req.method === "GET") {
		return json({
			filename: link.filename,
			size: link.size,
			mime_type: link.mime_type,
			password_required: true,
		});
	}

	return json({
		filename: link.filename,
		size: link.size,
		mime_type: link.mime_type,
		password_required: false,
	});
}

export async function handleDownloadViaLink(
	req: Request,
	linkId: string,
): Promise<Response> {
	const link = db
		.query("SELECT * FROM share_links WHERE id = ?")
		.get(linkId) as any;
	if (!link) return json({ error: "Link not found" }, 404);
	if (link.expires_at && new Date(link.expires_at) < new Date())
		return json({ error: "Link expired" }, 410);
	if (link.max_downloads !== null && link.downloads >= link.max_downloads)
		return json({ error: "Download limit reached" }, 410);

	let overrideFileKey: Buffer | undefined;

	if (link.pass_salt) {
		// Password-protected: client must supply password via header or body
		const password =
			req.headers.get("X-Share-Password") ||
			(req.method === "POST"
				? (await req.json().catch(() => ({}) as any)).password
				: null);

		if (!password) {
			return json(
				{ error: "password required", code: "PASSWORD_REQUIRED" },
				401,
			);
		}
		try {
			overrideFileKey = unwrapKeyWithPassword(
				link.pass_key_wrapped,
				link.pass_key_iv,
				link.pass_key_tag,
				link.pass_salt,
				password,
			);
		} catch {
			debug(`link:wrong-password id=${linkId}`);
			return json({ error: "Wrong password" }, 401);
		}
	}

	// Increment download counter
	db.query("UPDATE share_links SET downloads = downloads + 1 WHERE id = ?").run(
		linkId,
	);
	debug(`link:download id=${linkId} fileId=${link.file_id} passwordProtected=${!!link.pass_salt} downloads=${link.downloads + 1}`);

	// Serve using the files module (pass overrideFileKey to bypass auth check)
	return serveFile(req, link.file_id, 0, "anonymous", overrideFileKey);
}
