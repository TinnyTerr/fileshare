import { db } from '../db';
import { json, requireAuth, isResponse } from '../middleware/auth';

function isGroupAdmin(groupId: number, userId: number): boolean {
  const m = db.query("SELECT role FROM group_members WHERE group_id = ? AND user_id = ?").get(groupId, userId) as any;
  return m?.role === 'owner' || m?.role === 'admin';
}

function isMember(groupId: number, userId: number): boolean {
  return !!db.query('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, userId);
}

export async function handleCreateGroup(req: Request): Promise<Response> {
  const auth = await requireAuth(req);
  if (isResponse(auth)) return auth;

  const body = await req.json().catch(() => null);
  if (!body?.name?.trim()) return json({ error: 'name required' }, 400);

  const result = db.query(
    "INSERT INTO groups (name, owner_id) VALUES (?, ?) RETURNING id, name, owner_id, created_at"
  ).get(body.name.trim(), auth.userId) as any;

  // Creator is automatically owner member
  db.query("INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'owner')").run(result.id, auth.userId);

  return json(result, 201);
}

export async function handleListGroups(req: Request): Promise<Response> {
  const auth = await requireAuth(req);
  if (isResponse(auth)) return auth;

  const groups = db.query(`
    SELECT g.id, g.name, g.owner_id, g.created_at, gm.role,
      (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count
    FROM groups g
    JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ?
    ORDER BY g.name
  `).all(auth.userId);

  return json({ groups });
}

export async function handleGetGroup(req: Request, groupId: string): Promise<Response> {
  const auth = await requireAuth(req);
  if (isResponse(auth)) return auth;

  const gid = parseInt(groupId);
  if (!isMember(gid, auth.userId) && auth.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  const group = db.query('SELECT id, name, owner_id, created_at FROM groups WHERE id = ?').get(gid) as any;
  if (!group) return json({ error: 'Group not found' }, 404);

  const members = db.query(
    'SELECT u.id, u.email, gm.role, gm.joined_at FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? ORDER BY gm.role, u.email'
  ).all(gid);

  return json({ ...group, members });
}

export async function handleUpdateGroup(req: Request, groupId: string): Promise<Response> {
  const auth = await requireAuth(req);
  if (isResponse(auth)) return auth;

  const gid = parseInt(groupId);
  if (!isGroupAdmin(gid, auth.userId) && auth.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  const body = await req.json().catch(() => null);
  if (!body?.name?.trim()) return json({ error: 'name required' }, 400);

  db.query('UPDATE groups SET name = ? WHERE id = ?').run(body.name.trim(), gid);
  return json({ ok: true, id: gid, name: body.name.trim() });
}

export async function handleDeleteGroup(req: Request, groupId: string): Promise<Response> {
  const auth = await requireAuth(req);
  if (isResponse(auth)) return auth;

  const gid = parseInt(groupId);
  const group = db.query('SELECT owner_id FROM groups WHERE id = ?').get(gid) as any;
  if (!group) return json({ error: 'Group not found' }, 404);
  if (group.owner_id !== auth.userId && auth.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  db.query('DELETE FROM groups WHERE id = ?').run(gid);
  return json({ ok: true });
}

export async function handleAddMember(req: Request, groupId: string): Promise<Response> {
  const auth = await requireAuth(req);
  if (isResponse(auth)) return auth;

  const gid = parseInt(groupId);
  if (!isGroupAdmin(gid, auth.userId) && auth.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  const body = await req.json().catch(() => null);
  if (!body?.email) return json({ error: 'email required' }, 400);

  const target = db.query('SELECT id FROM users WHERE email = ?').get(body.email) as any;
  if (!target) return json({ error: 'User not found' }, 404);

  const role = ['owner', 'admin', 'member'].includes(body.role) ? body.role : 'member';
  db.query(
    "INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT(group_id, user_id) DO UPDATE SET role = excluded.role"
  ).run(gid, target.id, role);

  return json({ ok: true, email: body.email, role });
}

export async function handleRemoveMember(req: Request, groupId: string, userId: string): Promise<Response> {
  const auth = await requireAuth(req);
  if (isResponse(auth)) return auth;

  const gid = parseInt(groupId);
  const uid = parseInt(userId);

  // Allow self-removal; otherwise require admin
  if (uid !== auth.userId && !isGroupAdmin(gid, auth.userId) && auth.role !== 'admin') {
    return json({ error: 'Forbidden' }, 403);
  }

  const group = db.query('SELECT owner_id FROM groups WHERE id = ?').get(gid) as any;
  if (!group) return json({ error: 'Group not found' }, 404);
  if (uid === group.owner_id) return json({ error: 'Cannot remove group owner' }, 400);

  db.query('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(gid, uid);
  return json({ ok: true });
}

// Create an invite link (optionally password-protected)
export async function handleCreateInvite(req: Request, groupId: string): Promise<Response> {
  const auth = await requireAuth(req);
  if (isResponse(auth)) return auth;

  const gid = parseInt(groupId);
  if (!isGroupAdmin(gid, auth.userId) && auth.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  const body = await req.json().catch(() => null) as any ?? {};
  const { password, expires_days, max_uses } = body;

  const id = crypto.randomUUID();
  const expiresAt = expires_days ? new Date(Date.now() + expires_days * 86400000).toISOString() : null;
  const passHash = password ? await Bun.password.hash(password) : null;

  db.query(
    'INSERT INTO group_invites (id, group_id, created_by, pass_hash, max_uses, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, gid, auth.userId, passHash, max_uses ?? null, expiresAt);

  const serverUrl = process.env.SERVER_URL || `http://localhost:${process.env.PORT || 3000}`;
  return json({ id, invite_url: `${serverUrl}/api/groups/join/${id}`, expires_at: expiresAt, max_uses: max_uses ?? null }, 201);
}

export async function handleListInvites(req: Request, groupId: string): Promise<Response> {
  const auth = await requireAuth(req);
  if (isResponse(auth)) return auth;

  const gid = parseInt(groupId);
  if (!isGroupAdmin(gid, auth.userId) && auth.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  const invites = db.query(
    'SELECT id, created_by, max_uses, uses, expires_at, CASE WHEN pass_hash IS NOT NULL THEN 1 ELSE 0 END as has_password, created_at FROM group_invites WHERE group_id = ? ORDER BY created_at DESC'
  ).all(gid);

  return json({ invites });
}

export async function handleRevokeInvite(req: Request, groupId: string, inviteId: string): Promise<Response> {
  const auth = await requireAuth(req);
  if (isResponse(auth)) return auth;

  const gid = parseInt(groupId);
  if (!isGroupAdmin(gid, auth.userId) && auth.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  db.query('DELETE FROM group_invites WHERE id = ? AND group_id = ?').run(inviteId, gid);
  return json({ ok: true });
}

// Join a group via invite token (public — no auth required if invite has no password)
export async function handleJoinGroup(req: Request, inviteId: string): Promise<Response> {
  const auth = await requireAuth(req);
  if (isResponse(auth)) return auth;

  const invite = db.query("SELECT * FROM group_invites WHERE id = ?").get(inviteId) as any;
  if (!invite) return json({ error: 'Invite not found or expired' }, 404);
  if (invite.expires_at && new Date(invite.expires_at) < new Date()) return json({ error: 'Invite expired' }, 410);
  if (invite.max_uses !== null && invite.uses >= invite.max_uses) return json({ error: 'Invite use limit reached' }, 410);

  // Password check
  if (invite.pass_hash) {
    const body = await req.json().catch(() => null);
    const password = body?.password;
    if (!password) return json({ error: 'password required for this invite', code: 'PASSWORD_REQUIRED' }, 401);
    if (!(await Bun.password.verify(password, invite.pass_hash))) return json({ error: 'Wrong invite password' }, 401);
  }

  // Already a member?
  if (isMember(invite.group_id, auth.userId)) return json({ error: 'Already a member' }, 409);

  db.query("INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'member')").run(invite.group_id, auth.userId);
  db.query('UPDATE group_invites SET uses = uses + 1 WHERE id = ?').run(inviteId);

  const group = db.query('SELECT id, name FROM groups WHERE id = ?').get(invite.group_id);
  return json({ ok: true, group });
}

export async function handleLeaveGroup(req: Request, groupId: string): Promise<Response> {
  const auth = await requireAuth(req);
  if (isResponse(auth)) return auth;

  const gid = parseInt(groupId);
  const group = db.query('SELECT owner_id FROM groups WHERE id = ?').get(gid) as any;
  if (!group) return json({ error: 'Group not found' }, 404);
  if (group.owner_id === auth.userId) return json({ error: 'Owner cannot leave — delete the group instead' }, 400);

  db.query('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(gid, auth.userId);
  return json({ ok: true });
}
