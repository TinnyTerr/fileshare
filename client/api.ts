import { loadConfig, saveConfig } from './config';
import { CHUNK_SIZE } from '../shared/types';

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

async function refreshTokens(): Promise<boolean> {
  const cfg = loadConfig();
  if (!cfg.refresh_token) return false;

  const res = await fetch(`${cfg.server}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: cfg.refresh_token }),
  });

  if (!res.ok) return false;

  const data = await res.json() as any;
  saveConfig({ access_token: data.access_token, refresh_token: data.refresh_token });
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

  const headers: Record<string, string> = {
    ...(cfg.access_token ? { Authorization: `Bearer ${cfg.access_token}` } : {}),
    ...(body && !(body instanceof ArrayBuffer) ? { 'Content-Type': 'application/json' } : {}),
    ...extraHeaders,
  };

  const res = await fetch(`${cfg.server}${path}`, {
    method,
    headers,
    body: body instanceof ArrayBuffer
      ? body
      : body
        ? JSON.stringify(body)
        : undefined,
  });

  if (res.status === 401 && retry) {
    const refreshed = await refreshTokens();
    if (refreshed) return request(method, path, body, extraHeaders, false);
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as any;
    throw new ApiError(res.status, err.error || 'Request failed', err.code);
  }

  const ct = res.headers.get('Content-Type') || '';
  if (ct.includes('application/json')) return res.json();
  return res;
}

// Auth
export const api = {
  auth: {
    register: (email: string, password: string) =>
      request('POST', '/api/auth/register', { email, password }),
    login: (email: string, password: string) =>
      request('POST', '/api/auth/login', { email, password }),
    logout: (refresh_token: string) =>
      request('POST', '/api/auth/logout', { refresh_token }),
    me: () => request('GET', '/api/auth/me'),
  },

  files: {
    list: (page = 1, limit = 20) =>
      request('GET', `/api/files?page=${page}&limit=${limit}`),

    initUpload: (filename: string, size: number, mime_type?: string, expires_days?: number) =>
      request('POST', '/api/files', { filename, size, mime_type, expires_days }),

    uploadChunk: (fileId: string, chunk: ArrayBuffer, start: number, total: number) => {
      const end = start + chunk.byteLength - 1;
      return request('PUT', `/api/files/${fileId}/data`, chunk, {
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Content-Type': 'application/octet-stream',
      });
    },

    getMeta: (fileId: string) => request('GET', `/api/files/${fileId}`),

    async downloadChunk(fileId: string, start: number, end: number): Promise<{ data: ArrayBuffer; contentRange: string; total: number }> {
      const cfg = loadConfig();
      const headers: Record<string, string> = {
        Range: `bytes=${start}-${end}`,
        ...(cfg.access_token ? { Authorization: `Bearer ${cfg.access_token}` } : {}),
      };

      const res = await fetch(`${cfg.server}/api/files/${fileId}/data`, { headers });
      if (res.status === 401) {
        const refreshed = await refreshTokens();
        if (refreshed) return api.files.downloadChunk(fileId, start, end);
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText })) as any;
        throw new ApiError(res.status, err.error || 'Download failed', err.code);
      }

      const cr = res.headers.get('Content-Range') || '';
      const totalMatch = cr.match(/\/(\d+)$/);
      const total = totalMatch ? parseInt(totalMatch[1]!) : 0;
      return { data: await res.arrayBuffer(), contentRange: cr, total };
    },

    delete: (fileId: string) => request('DELETE', `/api/files/${fileId}`),

    share: (fileId: string, email: string, can_write = false) =>
      request('POST', `/api/files/${fileId}/share`, { email, can_write }),

    unshare: (fileId: string, email: string) =>
      request('DELETE', `/api/files/${fileId}/share`, { email }),
  },

  admin: {
    listUsers: (page = 1, limit = 20) => request('GET', `/api/admin/users?page=${page}&limit=${limit}`),
    getUser: (id: number) => request('GET', `/api/admin/users/${id}`),
    setSubscription: (id: number, tier: string) => request('PUT', `/api/admin/users/${id}/subscription`, { tier }),
    setRole: (id: number, role: string) => request('PUT', `/api/admin/users/${id}/role`, { role }),
    deleteUser: (id: number) => request('DELETE', `/api/admin/users/${id}`),
    stats: () => request('GET', '/api/admin/stats'),
  },

  version: {
    latest: (platform?: string) =>
      request('GET', `/api/version${platform ? `?platform=${platform}` : ''}`),
    history: (platform?: string) =>
      request('GET', `/api/version/history${platform ? `?platform=${platform}` : ''}`),
  },

  groups: {
    create: (name: string) => request('POST', '/api/groups', { name }),
    list: () => request('GET', '/api/groups'),
    get: (id: number) => request('GET', `/api/groups/${id}`),
    update: (id: number, name: string) => request('PUT', `/api/groups/${id}`, { name }),
    delete: (id: number) => request('DELETE', `/api/groups/${id}`),
    addMember: (id: number, email: string, role = 'member') =>
      request('POST', `/api/groups/${id}/members`, { email, role }),
    removeMember: (groupId: number, userId: number) =>
      request('DELETE', `/api/groups/${groupId}/members/${userId}`),
    createInvite: (id: number, opts: { password?: string; expires_days?: number; max_uses?: number }) =>
      request('POST', `/api/groups/${id}/invites`, opts),
    listInvites: (id: number) => request('GET', `/api/groups/${id}/invites`),
    revokeInvite: (groupId: number, inviteId: string) =>
      request('DELETE', `/api/groups/${groupId}/invites/${inviteId}`),
    join: (token: string, password?: string) =>
      request('POST', `/api/groups/join/${token}`, password ? { password } : {}),
    leave: (id: number) => request('DELETE', `/api/groups/${id}/leave`),
  },

  links: {
    create: (fileId: string, opts: { password?: string; expires_days?: number; max_downloads?: number; can_write?: boolean }) =>
      request('POST', `/api/files/${fileId}/links`, opts),
    list: (fileId: string) => request('GET', `/api/files/${fileId}/links`),
    revoke: (fileId: string, linkId: string) => request('DELETE', `/api/files/${fileId}/links/${linkId}`),
  },
};

// High-level upload with progress callback
export async function uploadFile(
  localPath: string,
  options: { expiresDays?: number; onProgress?: (pct: number) => void } = {}
): Promise<{ file_id: string; filename: string }> {
  const file = Bun.file(localPath);
  const size = file.size;
  const { basename } = await import('path');
  const filename = basename(localPath);
  const mime = file.type || 'application/octet-stream';

  const { file_id } = await api.files.initUpload(filename, size, mime, options.expiresDays);

  let offset = 0;
  while (offset < size) {
    const chunkEnd = Math.min(offset + CHUNK_SIZE, size);
    const slice = file.slice(offset, chunkEnd);
    const buf = await slice.arrayBuffer();
    await api.files.uploadChunk(file_id, buf, offset, size);
    offset = chunkEnd;
    options.onProgress?.(Math.round((offset / size) * 100));
  }

  return { file_id, filename };
}

// High-level download with progress callback
export async function downloadFile(
  fileId: string,
  destPath: string,
  options: { onProgress?: (pct: number, totalBytes: number) => void } = {}
): Promise<void> {
  const meta = await api.files.getMeta(fileId) as any;
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
