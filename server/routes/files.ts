import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { CHUNK_SIZE, SUBSCRIPTION_LIMITS } from "../../shared/types";

const debug = process.env.DEBUG ? console.log.bind(console, "[debug]") : () => {};
import {
	CHUNK_HEADER_SIZE,
	decryptChunk,
	encryptChunk,
	generateFileKey,
	unwrapKey,
	wrapKey,
} from "../crypto";
import { db } from "../db";
import { isResponse, json, requireAuth } from "../middleware/auth";

const UPLOAD_DIR = process.env.UPLOAD_DIR || "./data/files";
const TMP_DIR = process.env.TMP_DIR || "./data/tmp";
mkdirSync(UPLOAD_DIR, { recursive: true });
mkdirSync(TMP_DIR, { recursive: true });

function fileDir(fileId: string) {
	return join(UPLOAD_DIR, fileId.slice(0, 2), fileId.slice(2, 4));
}
function filePath(fileId: string) {
	return join(fileDir(fileId), fileId);
}
function tmpDir(fileId: string) {
	return join(TMP_DIR, fileId);
}
function chunkPath(fileId: string, start: number) {
	return join(tmpDir(fileId), `chunk_${start}`);
}

function generateFileId(): string {
	return crypto.randomUUID().replace(/-/g, "");
}

// Check access: owner, admin, direct share, or group share
function canRead(fileId: string, userId: number, role: string): boolean {
	if (role === "admin") return true;
	const file = db
		.query("SELECT owner_id FROM files WHERE id = ?")
		.get(fileId) as any;
	if (!file) return false;
	if (file.owner_id === userId) return true;
	if (
		db
			.query("SELECT 1 FROM file_shares WHERE file_id = ? AND user_id = ?")
			.get(fileId, userId)
	)
		return true;
	if (
		db
			.query(`
    SELECT 1 FROM file_group_shares fgs
    JOIN group_members gm ON gm.group_id = fgs.group_id
    WHERE fgs.file_id = ? AND gm.user_id = ?
  `)
			.get(fileId, userId)
	)
		return true;
	return false;
}

function canWrite(fileId: string, userId: number, role: string): boolean {
	if (role === "admin") return true;
	const file = db
		.query("SELECT owner_id FROM files WHERE id = ?")
		.get(fileId) as any;
	if (!file) return false;
	if (file.owner_id === userId) return true;
	const share = db
		.query(
			"SELECT can_write FROM file_shares WHERE file_id = ? AND user_id = ?",
		)
		.get(fileId, userId) as any;
	if (share?.can_write) return true;
	const groupShare = db
		.query(`
    SELECT fgs.can_write FROM file_group_shares fgs
    JOIN group_members gm ON gm.group_id = fgs.group_id
    WHERE fgs.file_id = ? AND gm.user_id = ?
  `)
		.get(fileId, userId) as any;
	if (groupShare?.can_write) return true;
	return false;
}

// Encrypt all temp chunks and write assembled encrypted file; record chunk map in DB
async function assembleAndEncrypt(
	fileId: string,
	totalSize: number,
	fileKey: Buffer,
): Promise<void> {
	const dir = fileDir(fileId);
	mkdirSync(dir, { recursive: true });

	const { open, readFile, rm } = await import("fs/promises");
	const fh = await open(filePath(fileId), "w");

	const insertChunk = db.prepare(
		"INSERT INTO file_chunks (file_id, chunk_index, cleartext_start, cleartext_size, encrypted_offset) VALUES (?, ?, ?, ?, ?)",
	);

	let cleartextOffset = 0;
	let encryptedOffset = 0;
	let chunkIndex = 0;

	debug(`assemble:start fileId=${fileId} totalSize=${totalSize}`);
	try {
		while (cleartextOffset < totalSize) {
			const data = await readFile(chunkPath(fileId, cleartextOffset));
			const encrypted = encryptChunk(data, fileKey);
			await fh.write(encrypted);

			insertChunk.run(
				fileId,
				chunkIndex,
				cleartextOffset,
				data.length,
				encryptedOffset,
			);

			debug(`assemble:chunk fileId=${fileId} index=${chunkIndex} offset=${cleartextOffset} size=${data.length}`);
			encryptedOffset += encrypted.length;
			cleartextOffset += data.length;
			chunkIndex++;
		}
	} finally {
		await fh.close();
	}

	await rm(tmpDir(fileId), { recursive: true, force: true });
	debug(`assemble:done fileId=${fileId} chunks=${chunkIndex}`);
}

export async function handleInitUpload(req: Request): Promise<Response> {
	const auth = await requireAuth(req);
	if (isResponse(auth)) return auth;

	const body = await req.json().catch(() => null);
	if (!body?.filename || !body?.size) {
		return json({ error: "filename and size required" }, 400);
	}

	const {
		filename,
		size,
		mime_type = "application/octet-stream",
		expires_days,
	} = body;

	const user = db
		.query("SELECT subscription_tier, storage_used FROM users WHERE id = ?")
		.get(auth.userId) as any;
	const limits =
		SUBSCRIPTION_LIMITS[
			user.subscription_tier as keyof typeof SUBSCRIPTION_LIMITS
		] ?? SUBSCRIPTION_LIMITS.free;

	if (user.storage_used + size > limits.storage) {
		return json(
			{ error: "Storage quota exceeded", code: "QUOTA_EXCEEDED" },
			413,
		);
	}

	const fileId = generateFileId();
	const fileKey = generateFileKey();
	const { wrapped, iv, tag } = wrapKey(fileKey);
	const expiresAt = expires_days
		? new Date(Date.now() + expires_days * 86400000).toISOString()
		: null;

	db.query(
		"INSERT INTO files (id, owner_id, filename, size, mime_type, key_wrapped, key_iv, key_tag, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
	).run(
		fileId,
		auth.userId,
		filename,
		size,
		mime_type,
		wrapped,
		iv,
		tag,
		expiresAt,
	);

	mkdirSync(tmpDir(fileId), { recursive: true });
	debug(`upload:init fileId=${fileId} filename="${filename}" size=${size} userId=${auth.userId}${expiresAt ? ` expires=${expiresAt}` : ""}`);

	return json({ file_id: fileId, chunk_size: CHUNK_SIZE }, 201);
}

export async function handleUploadChunk(
	req: Request,
	fileId: string,
): Promise<Response> {
	const auth = await requireAuth(req);
	if (isResponse(auth)) return auth;

	const file = db.query("SELECT * FROM files WHERE id = ?").get(fileId) as any;
	if (!file) return json({ error: "File not found" }, 404);
	if (!canWrite(fileId, auth.userId, auth.role))
		return json({ error: "Forbidden" }, 403);
	if (file.status === "complete")
		return json({ error: "Upload already complete" }, 409);

	const contentRange = req.headers.get("Content-Range");
	if (!contentRange)
		return json({ error: "Content-Range header required" }, 400);

	const match = contentRange.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
	if (!match)
		return json(
			{ error: "Invalid Content-Range. Expected: bytes start-end/total" },
			400,
		);

	const start = parseInt(match[1]!);
	const end = parseInt(match[2]!);
	const total = parseInt(match[3]!);
	const chunkSize = end - start + 1;

	if (chunkSize > CHUNK_SIZE) {
		return json(
			{
				error: `Chunk exceeds 100MB limit (got ${Math.ceil(chunkSize / 1024 ** 2)}MB)`,
				code: "CHUNK_TOO_LARGE",
			},
			413,
		);
	}
	if (total !== file.size) return json({ error: "Total size mismatch" }, 400);

	let body: ArrayBuffer;
	try {
		body = await req.arrayBuffer();
	} catch {
		return json({ error: "Upload connection interrupted" }, 400);
	}
	if (body.byteLength !== chunkSize)
		return json({ error: "Body size does not match Content-Range" }, 400);

	await Bun.write(chunkPath(fileId, start), body);

	const newBytesReceived = file.bytes_received + chunkSize;
	db.query("UPDATE files SET bytes_received = ? WHERE id = ?").run(
		newBytesReceived,
		fileId,
	);
	debug(`upload:chunk fileId=${fileId} range=${start}-${end}/${total} received=${newBytesReceived}`);

	if (newBytesReceived >= file.size) {
		const fileKey = unwrapKey(file.key_wrapped, file.key_iv, file.key_tag);
		await assembleAndEncrypt(fileId, file.size, fileKey);

		db.query(
			"UPDATE files SET status = 'complete', bytes_received = size WHERE id = ?",
		).run(fileId);
		db.query(
			"UPDATE users SET storage_used = storage_used + ? WHERE id = ?",
		).run(file.size, file.owner_id);

		const complete = db
			.query(
				"SELECT id, filename, size, mime_type, status, created_at, expires_at FROM files WHERE id = ?",
			)
			.get(fileId);
		debug(`upload:complete fileId=${fileId} size=${file.size}`);
		return json({ complete: true, file: complete });
	}

	return json(
		{
			complete: false,
			bytes_received: newBytesReceived,
			bytes_remaining: file.size - newBytesReceived,
		},
		202,
	);
}

export async function handleDownload(
	req: Request,
	fileId: string,
): Promise<Response> {
	const auth = await requireAuth(req);
	if (isResponse(auth)) return auth;

	return serveFile(req, fileId, auth.userId, auth.role);
}

// Shared download logic used by both authenticated and share-link routes
export async function serveFile(
	req: Request,
	fileId: string,
	userId: number,
	role: string,
	overrideFileKey?: Buffer,
): Promise<Response> {
	const file = db.query("SELECT * FROM files WHERE id = ?").get(fileId) as any;
	if (!file) return json({ error: "File not found" }, 404);
	if (file.status !== "complete")
		return json({ error: "Upload incomplete" }, 409);
	if (file.expires_at && new Date(file.expires_at) < new Date())
		return json({ error: "File expired" }, 410);

	if (!overrideFileKey && !canRead(fileId, userId, role))
		return json({ error: "Forbidden" }, 403);

	const path = filePath(fileId);
	if (!existsSync(path)) return json({ error: "File data missing" }, 404);

	const fileKey =
		overrideFileKey ?? unwrapKey(file.key_wrapped, file.key_iv, file.key_tag);
	const totalSize: number = file.size;

	const rangeHeader = req.headers.get("Range");
	let reqStart = 0;
	let reqEnd = Math.min(CHUNK_SIZE - 1, totalSize - 1);

	if (rangeHeader) {
		const match = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
		if (!match) return new Response("Invalid Range header", { status: 416 });

		reqStart = parseInt(match[1]!);
		const requestedEnd = match[2]
			? parseInt(match[2])
			: reqStart + CHUNK_SIZE - 1;

		if (requestedEnd - reqStart + 1 > CHUNK_SIZE) {
			return json(
				{
					error: "Range exceeds 100MB. Request at most 100MB per request.",
					code: "RANGE_TOO_LARGE",
				},
				413,
			);
		}
		reqEnd = Math.min(requestedEnd, totalSize - 1);
	}

	if (reqStart >= totalSize) {
		return new Response(null, {
			status: 416,
			headers: { "Content-Range": `bytes */${totalSize}` },
		});
	}

	debug(`download fileId=${fileId} userId=${userId} range=${reqStart}-${reqEnd}/${totalSize}`);
	// Find which encrypted chunks cover [reqStart, reqEnd]
	const chunks = db
		.query(`
    SELECT chunk_index, cleartext_start, cleartext_size, encrypted_offset
    FROM file_chunks WHERE file_id = ? AND cleartext_start < ? AND cleartext_start + cleartext_size > ?
    ORDER BY chunk_index
  `)
		.all(fileId, reqEnd + 1, reqStart) as any[];

	debug(`download:chunks fileId=${fileId} covering=${chunks.length} encrypted chunks`);
	const encFile = Bun.file(path);
	const parts: Buffer[] = [];

	for (const chunk of chunks) {
		const encSize = chunk.cleartext_size + CHUNK_HEADER_SIZE;
		const encBytes = await encFile
			.slice(chunk.encrypted_offset, chunk.encrypted_offset + encSize)
			.arrayBuffer();
		const cleartext = decryptChunk(Buffer.from(encBytes), fileKey);

		const sliceFrom = Math.max(0, reqStart - chunk.cleartext_start);
		const sliceTo = Math.min(
			chunk.cleartext_size,
			reqEnd - chunk.cleartext_start + 1,
		);
		parts.push(cleartext.subarray(sliceFrom, sliceTo));
	}

	const output = Buffer.concat(parts);
	const actualEnd = reqStart + output.length - 1;

	return new Response(output, {
		status: rangeHeader ? 206 : totalSize > CHUNK_SIZE ? 206 : 200,
		headers: {
			"Content-Type": file.mime_type,
			"Content-Range": `bytes ${reqStart}-${actualEnd}/${totalSize}`,
			"Content-Length": String(output.length),
			"Accept-Ranges": "bytes",
			"Content-Disposition": `attachment; filename="${file.filename}"`,
			...(totalSize > CHUNK_SIZE ? { "X-Chunked-Download": "true" } : {}),
		},
	});
}

export async function handleGetFileMeta(
	req: Request,
	fileId: string,
): Promise<Response> {
	const auth = await requireAuth(req);
	if (isResponse(auth)) return auth;

	const file = db
		.query(
			"SELECT id, owner_id, filename, size, mime_type, status, bytes_received, created_at, expires_at FROM files WHERE id = ?",
		)
		.get(fileId) as any;
	if (!file) return json({ error: "File not found" }, 404);
	if (!canRead(fileId, auth.userId, auth.role))
		return json({ error: "Forbidden" }, 403);

	const shares = db
		.query(
			"SELECT u.username, fs.can_write FROM file_shares fs JOIN users u ON u.id = fs.user_id WHERE fs.file_id = ?",
		)
		.all(fileId);

	const groups = db
		.query(
			"SELECT g.id, g.name, fgs.can_write FROM file_group_shares fgs JOIN groups g ON g.id = fgs.group_id WHERE fgs.file_id = ?",
		)
		.all(fileId);

	const links = db
		.query(
			"SELECT id, max_downloads, downloads, expires_at, CASE WHEN pass_salt IS NOT NULL THEN 1 ELSE 0 END as has_password, created_at FROM share_links WHERE file_id = ?",
		)
		.all(fileId);

	return json({ ...file, shares, groups, links });
}

export async function handleListFiles(req: Request): Promise<Response> {
	const auth = await requireAuth(req);
	if (isResponse(auth)) return auth;

	const url = new URL(req.url);
	const page = Math.max(1, parseInt(url.searchParams.get("page") || "1"));
	const limit = Math.min(100, parseInt(url.searchParams.get("limit") || "20"));
	const offset = (page - 1) * limit;

	const owned = db
		.query(
			"SELECT id, filename, size, mime_type, status, created_at, expires_at FROM files WHERE owner_id = ? AND status = 'complete' ORDER BY created_at DESC LIMIT ? OFFSET ?",
		)
		.all(auth.userId, limit, offset);

	const shared = db
		.query(
			"SELECT f.id, f.filename, f.size, f.mime_type, f.status, f.created_at, f.expires_at, fs.can_write FROM files f JOIN file_shares fs ON fs.file_id = f.id WHERE fs.user_id = ? AND f.status = 'complete'",
		)
		.all(auth.userId);

	const groupShared = db
		.query(`
    SELECT DISTINCT f.id, f.filename, f.size, f.mime_type, f.status, f.created_at, f.expires_at, fgs.can_write, g.name as group_name
    FROM files f
    JOIN file_group_shares fgs ON fgs.file_id = f.id
    JOIN group_members gm ON gm.group_id = fgs.group_id
    JOIN groups g ON g.id = fgs.group_id
    WHERE gm.user_id = ? AND f.status = 'complete'
  `)
		.all(auth.userId);

	const total = (
		db
			.query(
				"SELECT COUNT(*) as c FROM files WHERE owner_id = ? AND status = 'complete'",
			)
			.get(auth.userId) as any
	).c;
	return json({
		files: owned,
		shared,
		group_shared: groupShared,
		total,
		page,
		limit,
	});
}

export async function handleDeleteFile(
	req: Request,
	fileId: string,
): Promise<Response> {
	const auth = await requireAuth(req);
	if (isResponse(auth)) return auth;

	const file = db.query("SELECT * FROM files WHERE id = ?").get(fileId) as any;
	if (!file) return json({ error: "File not found" }, 404);
	if (file.owner_id !== auth.userId && auth.role !== "admin")
		return json({ error: "Forbidden" }, 403);

	debug(`delete fileId=${fileId} userId=${auth.userId} status=${file.status} size=${file.size}`);
	db.query("DELETE FROM files WHERE id = ?").run(fileId);

	if (file.status === "complete") {
		db.query(
			"UPDATE users SET storage_used = MAX(0, storage_used - ?) WHERE id = ?",
		).run(file.size, file.owner_id);
		const { rmSync } = await import("fs");
		rmSync(filePath(fileId), { force: true });
	} else {
		const { rmSync } = await import("fs");
		rmSync(tmpDir(fileId), { recursive: true, force: true });
	}

	return json({ ok: true });
}

export async function handleShareFile(
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

	const body = await req.json().catch(() => null);
	if (!body?.username) return json({ error: "username required" }, 400);

	const target = db
		.query("SELECT id FROM users WHERE username = ?")
		.get(body.username) as any;
	if (!target) return json({ error: "User not found" }, 404);
	if (target.id === auth.userId)
		return json({ error: "Cannot share with yourself" }, 400);

	const canWriteVal = body.can_write ? 1 : 0;
	db.query(
		"INSERT INTO file_shares (file_id, user_id, can_write) VALUES (?, ?, ?) ON CONFLICT(file_id, user_id) DO UPDATE SET can_write = excluded.can_write",
	).run(fileId, target.id, canWriteVal);

	return json({
		ok: true,
		shared_with: body.username,
		can_write: !!canWriteVal,
	});
}

export async function handleUnshareFile(
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

	const body = await req.json().catch(() => null);
	if (!body?.username) return json({ error: "username required" }, 400);

	const target = db
		.query("SELECT id FROM users WHERE username = ?")
		.get(body.username) as any;
	if (!target) return json({ error: "User not found" }, 404);

	db.query("DELETE FROM file_shares WHERE file_id = ? AND user_id = ?").run(
		fileId,
		target.id,
	);
	return json({ ok: true });
}

export async function handleShareGroup(
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

	const body = await req.json().catch(() => null);
	if (!body?.group_id) return json({ error: "group_id required" }, 400);

	const group = db
		.query("SELECT id FROM groups WHERE id = ?")
		.get(body.group_id) as any;
	if (!group) return json({ error: "Group not found" }, 404);

	const canWriteVal = body.can_write ? 1 : 0;
	db.query(
		"INSERT INTO file_group_shares (file_id, group_id, can_write) VALUES (?, ?, ?) ON CONFLICT(file_id, group_id) DO UPDATE SET can_write = excluded.can_write",
	).run(fileId, body.group_id, canWriteVal);

	return json({ ok: true, group_id: body.group_id, can_write: !!canWriteVal });
}

export async function handleUnshareGroup(
	req: Request,
	fileId: string,
	groupId: string,
): Promise<Response> {
	const auth = await requireAuth(req);
	if (isResponse(auth)) return auth;

	const file = db
		.query("SELECT owner_id FROM files WHERE id = ?")
		.get(fileId) as any;
	if (!file) return json({ error: "File not found" }, 404);
	if (file.owner_id !== auth.userId && auth.role !== "admin")
		return json({ error: "Forbidden" }, 403);

	db.query(
		"DELETE FROM file_group_shares WHERE file_id = ? AND group_id = ?",
	).run(fileId, groupId);
	return json({ ok: true });
}
