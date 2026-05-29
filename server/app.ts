import { handleRegister, handleLogin, handleRefresh, handleLogout, handleMe } from './routes/auth';
import {
  handleInitUpload, handleUploadChunk, handleDownload, handleGetFileMeta,
  handleListFiles, handleDeleteFile, handleShareFile, handleUnshareFile,
  handleShareGroup, handleUnshareGroup,
} from './routes/files';
import { handleListUsers, handleGetUser, handleUpdateSubscription, handleUpdateRole, handleDeleteUser, handleStats } from './routes/admin';
import { handleGetLatestVersion, handleDownloadClient, handlePublishVersion, handleListVersions, handleInstallSh, handleInstallPs1 } from './routes/versions';
import {
  handleCreateGroup, handleListGroups, handleGetGroup, handleUpdateGroup, handleDeleteGroup,
  handleAddMember, handleRemoveMember, handleCreateInvite, handleListInvites, handleRevokeInvite,
  handleJoinGroup, handleLeaveGroup,
} from './routes/groups';
import { handleCreateLink, handleListLinks, handleRevokeLink, handleAccessLink, handleDownloadViaLink } from './routes/links';

function cors(res: Response): Response {
  res.headers.set('Access-Control-Allow-Origin', '*');
  res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Range, X-Deploy-Key, Range, X-Share-Password');
  res.headers.set('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, X-SHA256, X-Chunked-Download');
  return res;
}

function notFound(): Response {
  return new Response(JSON.stringify({ error: 'Not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function route(req: Request, method: string, path: string): Promise<Response> {
  // Auth
  if (method === 'POST' && path === '/api/auth/register') return handleRegister(req);
  if (method === 'POST' && path === '/api/auth/login')    return handleLogin(req);
  if (method === 'POST' && path === '/api/auth/refresh')  return handleRefresh(req);
  if (method === 'POST' && path === '/api/auth/logout')   return handleLogout(req);
  if (method === 'GET'  && path === '/api/auth/me')       return handleMe(req);

  // Files
  if (method === 'GET'  && path === '/api/files') return handleListFiles(req);
  if (method === 'POST' && path === '/api/files') return handleInitUpload(req);

  const fileMatch = path.match(/^\/api\/files\/([a-f0-9]{32})(.*)$/);
  if (fileMatch) {
    const fileId = fileMatch[1]!;
    const sub    = fileMatch[2]!;
    if (method === 'GET'    && sub === '')               return handleGetFileMeta(req, fileId);
    if (method === 'GET'    && sub === '/data')          return handleDownload(req, fileId);
    if (method === 'PUT'    && sub === '/data')          return handleUploadChunk(req, fileId);
    if (method === 'DELETE' && sub === '')               return handleDeleteFile(req, fileId);
    if (method === 'POST'   && sub === '/share')         return handleShareFile(req, fileId);
    if (method === 'DELETE' && sub === '/share')         return handleUnshareFile(req, fileId);
    if (method === 'POST'   && sub === '/share-group')   return handleShareGroup(req, fileId);
    // DELETE /api/files/:id/share-group/:groupId
    const groupShareMatch = sub.match(/^\/share-group\/(\d+)$/);
    if (method === 'DELETE' && groupShareMatch) return handleUnshareGroup(req, fileId, groupShareMatch[1]!);
    // Share links for this file
    if (method === 'POST'   && sub === '/links') return handleCreateLink(req, fileId);
    if (method === 'GET'    && sub === '/links') return handleListLinks(req, fileId);
    const linkMatch = sub.match(/^\/links\/([^/]+)$/);
    if (method === 'DELETE' && linkMatch) return handleRevokeLink(req, fileId, linkMatch[1]!);
  }

  // Admin
  if (method === 'GET' && path === '/api/admin/users') return handleListUsers(req);
  if (method === 'GET' && path === '/api/admin/stats') return handleStats(req);

  const userMatch = path.match(/^\/api\/admin\/users\/(\d+)(.*)$/);
  if (userMatch) {
    const userId = userMatch[1]!;
    const sub    = userMatch[2]!;
    if (method === 'GET'    && sub === '')              return handleGetUser(req, userId);
    if (method === 'DELETE' && sub === '')              return handleDeleteUser(req, userId);
    if (method === 'PUT'    && sub === '/subscription') return handleUpdateSubscription(req, userId);
    if (method === 'PUT'    && sub === '/role')         return handleUpdateRole(req, userId);
  }

  // Groups
  if (method === 'GET'  && path === '/api/groups') return handleListGroups(req);
  if (method === 'POST' && path === '/api/groups') return handleCreateGroup(req);

  const groupMatch = path.match(/^\/api\/groups\/(\d+)(.*)$/);
  if (groupMatch) {
    const groupId = groupMatch[1]!;
    const sub     = groupMatch[2]!;
    if (method === 'GET'    && sub === '')           return handleGetGroup(req, groupId);
    if (method === 'PUT'    && sub === '')           return handleUpdateGroup(req, groupId);
    if (method === 'DELETE' && sub === '')           return handleDeleteGroup(req, groupId);
    if (method === 'POST'   && sub === '/members')   return handleAddMember(req, groupId);
    if (method === 'DELETE' && sub === '/leave')     return handleLeaveGroup(req, groupId);
    const memberMatch = sub.match(/^\/members\/(\d+)$/);
    if (method === 'DELETE' && memberMatch) return handleRemoveMember(req, groupId, memberMatch[1]!);
    if (method === 'POST'   && sub === '/invites')   return handleCreateInvite(req, groupId);
    if (method === 'GET'    && sub === '/invites')   return handleListInvites(req, groupId);
    const inviteMatch = sub.match(/^\/invites\/([^/]+)$/);
    if (method === 'DELETE' && inviteMatch) return handleRevokeInvite(req, groupId, inviteMatch[1]!);
  }

  const joinMatch = path.match(/^\/api\/groups\/join\/([^/]+)$/);
  if (joinMatch && method === 'POST') return handleJoinGroup(req, joinMatch[1]!);

  // Share link access (public)
  const dlMatch = path.match(/^\/api\/dl\/([^/]+)$/);
  if (dlMatch) {
    if (method === 'GET')  return handleAccessLink(req, dlMatch[1]!);
    if (method === 'POST') return handleDownloadViaLink(req, dlMatch[1]!);
  }
  const dlDataMatch = path.match(/^\/api\/dl\/([^/]+)\/data$/);
  if (dlDataMatch) {
    if (method === 'GET' || method === 'POST') return handleDownloadViaLink(req, dlDataMatch[1]!);
  }

  // Install scripts
  if (method === 'GET' && path === '/install.sh')  return handleInstallSh(req);
  if (method === 'GET' && path === '/install.ps1') return handleInstallPs1(req);

  // Versions
  if (method === 'GET'  && path === '/api/version')         return handleGetLatestVersion(req);
  if (method === 'GET'  && path === '/api/version/history') return handleListVersions(req);
  if (method === 'POST' && path === '/api/version')         return handlePublishVersion(req);

  const vdlMatch = path.match(/^\/api\/version\/download\/([^/]+)\/([^/]+)$/);
  if (vdlMatch && method === 'GET') return handleDownloadClient(req, vdlMatch[1]!, vdlMatch[2]!);

  if (path === '/health') {
    return new Response(JSON.stringify({ ok: true, ts: new Date().toISOString() }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return notFound();
}

export function createServer(port: number): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port,
    async fetch(req: Request): Promise<Response> {
      if (req.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

      const url  = new URL(req.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';

      let res: Response;
      try {
        res = await route(req, req.method, path);
      } catch (err) {
        console.error('[error]', err);
        res = new Response(JSON.stringify({ error: 'Internal server error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return cors(res);
    },
  });
}
