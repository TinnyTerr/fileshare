import { db } from '../db';
import { json, requireAuth, requireAdmin, isResponse } from '../middleware/auth';
import type { SubscriptionTier } from '../../shared/types';
import { SUBSCRIPTION_LIMITS } from '../../shared/types';

export async function handleListUsers(req: Request): Promise<Response> {
  const auth = await requireAuth(req);
  if (isResponse(auth)) return auth;
  const deny = requireAdmin(auth);
  if (deny) return deny;

  const url = new URL(req.url);
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
  const limit = Math.min(100, parseInt(url.searchParams.get('limit') || '20'));
  const offset = (page - 1) * limit;

  const users = db.query(
    'SELECT id, email, role, subscription_tier, storage_used, created_at FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(limit, offset);

  const total = (db.query('SELECT COUNT(*) as c FROM users').get() as any).c;
  return json({ users, total, page, limit });
}

export async function handleGetUser(req: Request, userId: string): Promise<Response> {
  const auth = await requireAuth(req);
  if (isResponse(auth)) return auth;
  const deny = requireAdmin(auth);
  if (deny) return deny;

  const user = db.query(
    'SELECT id, email, role, subscription_tier, storage_used, created_at FROM users WHERE id = ?'
  ).get(userId) as any;

  if (!user) return json({ error: 'User not found' }, 404);

  const files = db.query(
    "SELECT id, filename, size, status, created_at FROM files WHERE owner_id = ? ORDER BY created_at DESC LIMIT 20"
  ).all(userId);

  return json({ ...user, files });
}

export async function handleUpdateSubscription(req: Request, userId: string): Promise<Response> {
  const auth = await requireAuth(req);
  if (isResponse(auth)) return auth;
  const deny = requireAdmin(auth);
  if (deny) return deny;

  const body = await req.json().catch(() => null);
  const tier = body?.tier as SubscriptionTier;

  if (!tier || !Object.keys(SUBSCRIPTION_LIMITS).includes(tier)) {
    return json({ error: `tier must be one of: ${Object.keys(SUBSCRIPTION_LIMITS).join(', ')}` }, 400);
  }

  const user = db.query('SELECT id FROM users WHERE id = ?').get(userId);
  if (!user) return json({ error: 'User not found' }, 404);

  db.query('UPDATE users SET subscription_tier = ? WHERE id = ?').run(tier, userId);
  return json({ ok: true, user_id: parseInt(userId), tier });
}

export async function handleUpdateRole(req: Request, userId: string): Promise<Response> {
  const auth = await requireAuth(req);
  if (isResponse(auth)) return auth;
  const deny = requireAdmin(auth);
  if (deny) return deny;

  const body = await req.json().catch(() => null);
  const role = body?.role;

  if (!role || !['user', 'admin'].includes(role)) {
    return json({ error: 'role must be "user" or "admin"' }, 400);
  }

  const user = db.query('SELECT id FROM users WHERE id = ?').get(userId);
  if (!user) return json({ error: 'User not found' }, 404);

  if (parseInt(userId) === auth.userId) {
    return json({ error: 'Cannot change your own role' }, 400);
  }

  db.query('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
  return json({ ok: true, user_id: parseInt(userId), role });
}

export async function handleDeleteUser(req: Request, userId: string): Promise<Response> {
  const auth = await requireAuth(req);
  if (isResponse(auth)) return auth;
  const deny = requireAdmin(auth);
  if (deny) return deny;

  if (parseInt(userId) === auth.userId) {
    return json({ error: 'Cannot delete your own account' }, 400);
  }

  const user = db.query('SELECT id FROM users WHERE id = ?').get(userId);
  if (!user) return json({ error: 'User not found' }, 404);

  db.query('DELETE FROM users WHERE id = ?').run(userId);
  return json({ ok: true });
}

export async function handleStats(_req: Request): Promise<Response> {
  const userCount = (db.query('SELECT COUNT(*) as c FROM users').get() as any).c;
  const fileCount = (db.query("SELECT COUNT(*) as c FROM files WHERE status = 'complete'").get() as any).c;
  const totalStorage = (db.query('SELECT COALESCE(SUM(storage_used), 0) as s FROM users').get() as any).s;
  const tierBreakdown = db.query(
    'SELECT subscription_tier, COUNT(*) as count FROM users GROUP BY subscription_tier'
  ).all();

  return json({ users: userCount, files: fileCount, total_storage_bytes: totalStorage, tiers: tierBreakdown });
}
