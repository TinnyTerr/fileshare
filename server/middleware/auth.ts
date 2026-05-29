import type { TokenPayload } from "../../shared/types";
import { verifyAccessToken } from "../auth";

export type AuthResult = TokenPayload | Response;

export async function requireAuth(req: Request): Promise<AuthResult> {
	const auth = req.headers.get("Authorization");
	if (!auth?.startsWith("Bearer ")) {
		return json({ error: "Unauthorized" }, 401);
	}
	try {
		return await verifyAccessToken(auth.slice(7));
	} catch {
		return json({ error: "Invalid or expired token" }, 401);
	}
}

export function requireAdmin(user: TokenPayload): Response | null {
	if (user.role !== "admin") return json({ error: "Forbidden" }, 403);
	return null;
}

export function requireDeployKey(req: Request): Response | null {
	const key = req.headers.get("X-Deploy-Key");
	if (!key || key !== process.env.DEPLOY_API_KEY) {
		return json({ error: "Invalid deploy key" }, 401);
	}
	return null;
}

export function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

export function isResponse(v: AuthResult): v is Response {
	return v instanceof Response;
}
