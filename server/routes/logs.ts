import { db } from "../db";
import { isResponse, json, requireAdmin, requireAuth } from "../middleware/auth";

interface LogEntry {
	ts: string;
	method: string;
	path: string;
	status?: number;
	duration_ms?: number;
	error?: string;
	client_version?: string;
}

export async function handleIngestLogs(req: Request): Promise<Response> {
	const auth = await requireAuth(req);
	if (isResponse(auth)) return auth;

	const body = await req.json().catch(() => null);
	if (!Array.isArray(body?.entries)) {
		return json({ error: "entries array required" }, 400);
	}

	const entries = body.entries as LogEntry[];
	if (entries.length === 0) return json({ ok: true, inserted: 0 });
	if (entries.length > 500) return json({ error: "too many entries (max 500)" }, 400);

	const insert = db.prepare(
		"INSERT INTO client_logs (user_id, username, ts, method, path, status, duration_ms, error, client_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
	);

	const insertMany = db.transaction((rows: LogEntry[]) => {
		for (const e of rows) {
			insert.run(
				auth.userId,
				auth.username,
				e.ts ?? new Date().toISOString(),
				(e.method ?? "").slice(0, 16),
				(e.path ?? "").slice(0, 256),
				e.status ?? null,
				e.duration_ms ?? null,
				e.error ? e.error.slice(0, 2048) : null,
				(e.client_version ?? "").slice(0, 32) || null,
			);
		}
	});

	insertMany(entries);
	return json({ ok: true, inserted: entries.length });
}

export async function handleGetLogs(req: Request): Promise<Response> {
	const auth = await requireAuth(req);
	if (isResponse(auth)) return auth;
	const deny = requireAdmin(auth);
	if (deny) return deny;

	const url = new URL(req.url);
	const page = Math.max(1, parseInt(url.searchParams.get("page") || "1"));
	const limit = Math.min(200, parseInt(url.searchParams.get("limit") || "50"));
	const offset = (page - 1) * limit;
	const userId = url.searchParams.get("user_id");
	const username = url.searchParams.get("username");
	const since = url.searchParams.get("since");
	const hasError = url.searchParams.get("errors_only") === "1";

	const conditions: string[] = [];
	const params: (string | number)[] = [];

	if (userId) { conditions.push("user_id = ?"); params.push(parseInt(userId)); }
	if (username) { conditions.push("username = ?"); params.push(username); }
	if (since) { conditions.push("created_at >= ?"); params.push(since); }
	if (hasError) { conditions.push("error IS NOT NULL"); }

	const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

	const logs = db
		.query(
			`SELECT id, user_id, username, ts, method, path, status, duration_ms, error, client_version, created_at
       FROM client_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
		)
		.all(...params, limit, offset);

	const total = (
		db.query(`SELECT COUNT(*) as c FROM client_logs ${where}`).get(...params) as any
	).c;

	return json({ logs, total, page, limit });
}
