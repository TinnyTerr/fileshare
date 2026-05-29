import { db } from '../db';
import {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  refreshTokenExpiry,
} from '../auth';
import { json, requireAuth, isResponse } from '../middleware/auth';

export async function handleRegister(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body?.email || !body?.password) {
    return json({ error: 'email and password required' }, 400);
  }

  const { email, password } = body as { email: string; password: string };
  if (password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400);

  const exists = db.query('SELECT id FROM users WHERE email = ?').get(email);
  if (exists) return json({ error: 'Email already registered' }, 409);

  const hash = await Bun.password.hash(password);
  const result = db
    .query('INSERT INTO users (email, password_hash) VALUES (?, ?) RETURNING id, email, role, subscription_tier, storage_used, created_at')
    .get(email, hash) as any;

  const accessToken = await signAccessToken({ userId: result.id, email: result.email, role: result.role });
  const refresh = generateRefreshToken();
  db.query('INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)').run(result.id, refresh, refreshTokenExpiry());

  return json({ user: result, access_token: accessToken, refresh_token: refresh }, 201);
}

export async function handleLogin(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body?.email || !body?.password) {
    return json({ error: 'email and password required' }, 400);
  }

  const user = db
    .query('SELECT * FROM users WHERE email = ?')
    .get(body.email) as any;

  if (!user || !(await Bun.password.verify(body.password, user.password_hash))) {
    return json({ error: 'Invalid credentials' }, 401);
  }

  const accessToken = await signAccessToken({ userId: user.id, email: user.email, role: user.role });
  const refresh = generateRefreshToken();
  db.query('INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)').run(user.id, refresh, refreshTokenExpiry());

  const { password_hash: _, ...safeUser } = user;
  return json({ user: safeUser, access_token: accessToken, refresh_token: refresh });
}

export async function handleRefresh(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body?.refresh_token) return json({ error: 'refresh_token required' }, 400);

  const row = db
    .query("SELECT * FROM refresh_tokens WHERE token = ? AND expires_at > datetime('now')")
    .get(body.refresh_token) as any;

  if (!row) return json({ error: 'Invalid or expired refresh token' }, 401);

  const user = db.query('SELECT id, email, role FROM users WHERE id = ?').get(row.user_id) as any;
  if (!user) return json({ error: 'User not found' }, 404);

  // Rotate refresh token
  db.query('DELETE FROM refresh_tokens WHERE token = ?').run(body.refresh_token);
  const newRefresh = generateRefreshToken();
  db.query('INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)').run(user.id, newRefresh, refreshTokenExpiry());

  const accessToken = await signAccessToken({ userId: user.id, email: user.email, role: user.role });
  return json({ access_token: accessToken, refresh_token: newRefresh });
}

export async function handleLogout(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (body?.refresh_token) {
    db.query('DELETE FROM refresh_tokens WHERE token = ?').run(body.refresh_token);
  }
  return json({ ok: true });
}

export async function handleMe(req: Request): Promise<Response> {
  const auth = await requireAuth(req);
  if (isResponse(auth)) return auth;

  const user = db
    .query('SELECT id, email, role, subscription_tier, storage_used, created_at FROM users WHERE id = ?')
    .get(auth.userId) as any;

  if (!user) return json({ error: 'User not found' }, 404);
  return json(user);
}
