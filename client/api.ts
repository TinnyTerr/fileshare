import { CHUNK_SIZE } from "../shared/types";
import { loadConfig, saveConfig } from "./config";

// ── Verbose / logging ────────────────────────────────────────────────────────

let _verbose = false;

export function setVerbose(v: boolean): void {
	_verbose = v;
}

interface LogEntry {
	ts: string;
	method: string;
	path: string;
	status?: number;
	duration_ms?: number;
	error?: string;
	client_version?: string;
}

const _logBuffer: LogEntry[] = [];

function logEntry(e: LogEntry): void {
	_logBuffer.push(e);
}

// Ship buffered log entries to the server. Clears the buffer regardless of success.
export async function flushClientLogs(): Promise<void> {
	if (_logBuffer.length === 0) return;
	const entries = _logBuffer.splice(0);
	const cfg = loadConfig();
	if (!cfg.access_token) return; // not logged in, nothing to do
	try {
		await fetch(`${cfg.server}/api/logs`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${cfg.access_token}`,
			},
			body: JSON.stringify({ entries }),
		});
	} catch {
		// best-effort; never throw
	}
}

export class ApiError extends Error {
	constructor(
		public status: number,
		message: string,
		public code?: string,
	) {
		super(message);
	}
}

async function refreshTokens(): Promise<boolean> {
	const cfg = loadConfig();
	if (!cfg.refresh_token) return false;

	const res = await fetch(`${cfg.server}/api/auth/refresh`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ refresh_token: cfg.refresh_token }),
	});

	if (!res.ok) return false;

	const data = (await res.json()) as any;
	saveConfig({
		access_token: data.access_token,
		refresh_token: data.refresh_token,
	});
	return true;
}

async function request(
	method: string,
	path: string,
	body?: unknown,
	extraHeaders?: Record<string, string>,
	retry = true,
): Promise<any> {
	const cfg = loadConfig();
	const verbose = _verbose || !!cfg.verbose;

	const headers: Record<string, string> = {
		...(cfg.access_token
			? { Authorization: `Bearer ${cfg.access_token}` }
			: {}),
		...(body && !(body instanceof ArrayBuffer)
			? { "Content-Type": "application/json" }
			: {}),
		...extraHeaders,
	};

	if (verbose) {
		const bodySize =
			body instanceof ArrayBuffer
				? `${body.byteLength} bytes`
				: body
					? `${JSON.stringify(body).length} bytes`
					: "no body";
		console.error(`[verbose] → ${method} ${path} (${bodySize})`);
		if (extraHeaders && Object.keys(extraHeaders).length) {
			for (const [k, v] of Object.entries(extraHeaders)) {
				if (k.toLowerCase() !== "authorization")
					console.error(`[verbose]   ${k}: ${v}`);
			}
		}
	}

	const start = Date.now();
	const ts = new Date().toISOString();
	let res: Response;
	try {
		res = await fetch(`${cfg.server}${path}`, {
			method,
			headers,
			body:
				body instanceof ArrayBuffer
					? body
					: body
						? JSON.stringify(body)
						: undefined,
		});
	} catch (err: any) {
		const duration_ms = Date.now() - start;
		const errorMsg = err?.message ?? String(err);
		if (verbose) {
			console.error(
				`[verbose] ✗ ${method} ${path} — network error after ${duration_ms}ms: ${errorMsg}`,
			);
			if (err?.stack) console.error(`[verbose]   ${err.stack}`);
		}
		logEntry({ ts, method, path, duration_ms, error: errorMsg, client_version: cfg.client_version });
		throw err;
	}

	const duration_ms = Date.now() - start;

	if (verbose) {
		console.error(
			`[verbose] ← ${res.status} ${res.statusText} (${duration_ms}ms)`,
		);
	}

	if (res.status === 401 && retry) {
		const refreshed = await refreshTokens();
		if (refreshed) return request(method, path, body, extraHeaders, false);
	}

	if (!res.ok) {
		const err = (await res
			.json()
			.catch(() => ({ error: res.statusText }))) as any;
		const errorMsg = err.error || "Request failed";
		logEntry({ ts, method, path, status: res.status, duration_ms, error: errorMsg, client_version: cfg.client_version });
		throw new ApiError(res.status, errorMsg, err.code);
	}

	logEntry({ ts, method, path, status: res.status, duration_ms, client_version: cfg.client_version });

	const ct = res.headers.get("Content-Type") || "";
	if (ct.includes("application/json")) return res.json();
	return res;
}

// Auth
export const api = {
	auth: {
		register: (username: string, password: string) =>
			request("POST", "/api/auth/register", { username, password }),
		login: (username: string, password: string) =>
			request("POST", "/api/auth/login", { username, password }),
		logout: (refresh_token: string) =>
			request("POST", "/api/auth/logout", { refresh_token }),
		me: () => request("GET", "/api/auth/me"),
	},

	files: {
		list: (page = 1, limit = 20) =>
			request("GET", `/api/files?page=${page}&limit=${limit}`),

		initUpload: (
			filename: string,
			size: number,
			mime_type?: string,
			expires_days?: number,
		) =>
			request("POST", "/api/files", {
				filename,
				size,
				mime_type,
				expires_days,
			}),

		uploadChunk: (
			fileId: string,
			chunk: ArrayBuffer,
			start: number,
			total: number,
		) => {
			const end = start + chunk.byteLength - 1;
			return request("PUT", `/api/files/${fileId}/data`, chunk, {
				"Content-Range": `bytes ${start}-${end}/${total}`,
				"Content-Type": "application/octet-stream",
			});
		},

		getMeta: (fileId: string) => request("GET", `/api/files/${fileId}`),

		async downloadChunk(
			fileId: string,
			start: number,
			end: number,
		): Promise<{ data: ArrayBuffer; contentRange: string; total: number }> {
			const cfg = loadConfig();
			const verbose = _verbose || !!cfg.verbose;
			const path = `/api/files/${fileId}/data`;
			const headers: Record<string, string> = {
				Range: `bytes=${start}-${end}`,
				...(cfg.access_token
					? { Authorization: `Bearer ${cfg.access_token}` }
					: {}),
			};

			if (verbose)
				console.error(`[verbose] → GET ${path} Range: bytes=${start}-${end}`);

			const ts = new Date().toISOString();
			const reqStart = Date.now();
			let res: Response;
			try {
				res = await fetch(`${cfg.server}${path}`, { headers });
			} catch (err: any) {
				const duration_ms = Date.now() - reqStart;
				const errorMsg = err?.message ?? String(err);
				if (verbose)
					console.error(
						`[verbose] ✗ GET ${path} — network error after ${duration_ms}ms: ${errorMsg}`,
					);
				logEntry({ ts, method: "GET", path, duration_ms, error: errorMsg, client_version: cfg.client_version });
				throw err;
			}

			const duration_ms = Date.now() - reqStart;
			if (verbose)
				console.error(`[verbose] ← ${res.status} (${duration_ms}ms)`);

			if (res.status === 401) {
				const refreshed = await refreshTokens();
				if (refreshed) return api.files.downloadChunk(fileId, start, end);
			}
			if (!res.ok) {
				const err = (await res
					.json()
					.catch(() => ({ error: res.statusText }))) as any;
				const errorMsg = err.error || "Download failed";
				logEntry({ ts, method: "GET", path, status: res.status, duration_ms, error: errorMsg, client_version: cfg.client_version });
				throw new ApiError(res.status, errorMsg, err.code);
			}

			logEntry({ ts, method: "GET", path, status: res.status, duration_ms, client_version: cfg.client_version });

			const cr = res.headers.get("Content-Range") || "";
			const totalMatch = cr.match(/\/(\d+)$/);
			const total = totalMatch ? parseInt(totalMatch[1]!) : 0;
			return { data: await res.arrayBuffer(), contentRange: cr, total };
		},

		delete: (fileId: string) => request("DELETE", `/api/files/${fileId}`),

		share: (fileId: string, username: string, can_write = false) =>
			request("POST", `/api/files/${fileId}/share`, { username, can_write }),

		unshare: (fileId: string, username: string) =>
			request("DELETE", `/api/files/${fileId}/share`, { username }),
	},

	admin: {
		listUsers: (page = 1, limit = 20) =>
			request("GET", `/api/admin/users?page=${page}&limit=${limit}`),
		getUser: (id: number) => request("GET", `/api/admin/users/${id}`),
		setSubscription: (id: number, tier: string) =>
			request("PUT", `/api/admin/users/${id}/subscription`, { tier }),
		setRole: (id: number, role: string) =>
			request("PUT", `/api/admin/users/${id}/role`, { role }),
		deleteUser: (id: number) => request("DELETE", `/api/admin/users/${id}`),
		stats: () => request("GET", "/api/admin/stats"),
		getLogs: (opts: {
			page?: number;
			limit?: number;
			user_id?: number;
			username?: string;
			since?: string;
			errors_only?: boolean;
		} = {}) => {
			const p = new URLSearchParams();
			if (opts.page) p.set("page", String(opts.page));
			if (opts.limit) p.set("limit", String(opts.limit));
			if (opts.user_id) p.set("user_id", String(opts.user_id));
			if (opts.username) p.set("username", opts.username);
			if (opts.since) p.set("since", opts.since);
			if (opts.errors_only) p.set("errors_only", "1");
			return request("GET", `/api/admin/logs?${p}`);
		},
	},

	version: {
		latest: (platform?: string) =>
			request("GET", `/api/version${platform ? `?platform=${platform}` : ""}`),
		history: (platform?: string) =>
			request(
				"GET",
				`/api/version/history${platform ? `?platform=${platform}` : ""}`,
			),
	},

	groups: {
		create: (name: string) => request("POST", "/api/groups", { name }),
		list: () => request("GET", "/api/groups"),
		get: (id: number) => request("GET", `/api/groups/${id}`),
		update: (id: number, name: string) =>
			request("PUT", `/api/groups/${id}`, { name }),
		delete: (id: number) => request("DELETE", `/api/groups/${id}`),
		addMember: (id: number, username: string, role = "member") =>
			request("POST", `/api/groups/${id}/members`, { username, role }),
		removeMember: (groupId: number, userId: number) =>
			request("DELETE", `/api/groups/${groupId}/members/${userId}`),
		createInvite: (
			id: number,
			opts: { password?: string; expires_days?: number; max_uses?: number },
		) => request("POST", `/api/groups/${id}/invites`, opts),
		listInvites: (id: number) => request("GET", `/api/groups/${id}/invites`),
		revokeInvite: (groupId: number, inviteId: string) =>
			request("DELETE", `/api/groups/${groupId}/invites/${inviteId}`),
		join: (token: string, password?: string) =>
			request(
				"POST",
				`/api/groups/join/${token}`,
				password ? { password } : {},
			),
		leave: (id: number) => request("DELETE", `/api/groups/${id}/leave`),
	},

	links: {
		create: (
			fileId: string,
			opts: {
				password?: string;
				expires_days?: number;
				max_downloads?: number;
				can_write?: boolean;
			},
		) => request("POST", `/api/files/${fileId}/links`, opts),
		list: (fileId: string) => request("GET", `/api/files/${fileId}/links`),
		revoke: (fileId: string, linkId: string) =>
			request("DELETE", `/api/files/${fileId}/links/${linkId}`),
	},
};

// High-level upload with progress callback
export async function uploadFile(
	localPath: string,
	options: { expiresDays?: number; onProgress?: (pct: number) => void } = {},
): Promise<{ file_id: string; filename: string }> {
	const file = Bun.file(localPath);
	const size = file.size;
	const { basename } = await import("path");
	const filename = basename(localPath);
	const mime = file.type || "application/octet-stream";
	const cfg = loadConfig();
	const verbose = _verbose || !!cfg.verbose;

	if (verbose) {
		console.error(
			`[verbose] upload start: ${filename} (${size} bytes, ${Math.ceil(size / CHUNK_SIZE)} chunk(s))`,
		);
	}

	const { file_id } = await api.files.initUpload(
		filename,
		size,
		mime,
		options.expiresDays,
	);

	let offset = 0;
	let chunkIndex = 0;
	while (offset < size) {
		const chunkEnd = Math.min(offset + CHUNK_SIZE, size);
		const slice = file.slice(offset, chunkEnd);
		const buf = await slice.arrayBuffer();

		if (verbose)
			console.error(
				`[verbose] uploading chunk ${chunkIndex} bytes ${offset}-${chunkEnd - 1}/${size}`,
			);

		const MAX_RETRIES = 3;
		for (let attempt = 1; ; attempt++) {
			try {
				await api.files.uploadChunk(file_id, buf, offset, size);
				break;
			} catch (err: any) {
				if (attempt > MAX_RETRIES) throw err;
				const delay = 1000 * attempt;
				if (verbose)
					console.error(
						`[verbose] chunk ${chunkIndex} failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}ms: ${err.message}`,
					);
				await new Promise((r) => setTimeout(r, delay));
			}
		}

		offset = chunkEnd;
		chunkIndex++;
		options.onProgress?.(Math.round((offset / size) * 100));
	}

	if (verbose) console.error(`[verbose] upload complete: ${file_id}`);
	return { file_id, filename };
}

// High-level download with progress callback
export async function downloadFile(
	fileId: string,
	destPath: string,
	options: { onProgress?: (pct: number, totalBytes: number) => void } = {},
): Promise<void> {
	const meta = (await api.files.getMeta(fileId)) as any;
	const total: number = meta.size;

	const writer = Bun.file(destPath).writer();
	let offset = 0;

	while (offset < total) {
		const end = Math.min(offset + CHUNK_SIZE - 1, total - 1);
		const { data } = await api.files.downloadChunk(fileId, offset, end);
		writer.write(data);
		offset += data.byteLength;
		options.onProgress?.(Math.round((offset / total) * 100), total);
	}

	await writer.end();
}
