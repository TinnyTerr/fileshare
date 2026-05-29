import { db } from '../db';
import { json, requireDeployKey } from '../middleware/auth';
import type { Platform } from '../../shared/types';
import { mkdirSync } from 'fs';
import { join } from 'path';

const CLIENTS_DIR = join(process.env.UPLOAD_DIR || './data/files', '../clients');
mkdirSync(CLIENTS_DIR, { recursive: true });

const PLATFORMS: Platform[] = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'windows-x64'];

export async function handleGetLatestVersion(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const platform = url.searchParams.get('platform') as Platform | null;

  if (platform) {
    if (!PLATFORMS.includes(platform)) {
      return json({ error: `Invalid platform. Must be one of: ${PLATFORMS.join(', ')}` }, 400);
    }
    const row = db.query(
      'SELECT version, platform, sha256, created_at FROM client_versions WHERE platform = ? AND is_latest = 1'
    ).get(platform) as any;

    if (!row) return json({ error: 'No release found for this platform' }, 404);

    const serverUrl = process.env.SERVER_URL || `http://localhost:${process.env.PORT || 3000}`;
    return json({ ...row, download_url: `${serverUrl}/api/version/download/${platform}/${row.version}` });
  }

  const rows = db.query(
    'SELECT version, platform, sha256, created_at FROM client_versions WHERE is_latest = 1 ORDER BY platform'
  ).all() as any[];

  const serverUrl = process.env.SERVER_URL || `http://localhost:${process.env.PORT || 3000}`;
  const versions = rows.map(r => ({
    ...r,
    download_url: `${serverUrl}/api/version/download/${r.platform}/${r.version}`,
  }));

  return json({ versions });
}

export async function handleDownloadClient(req: Request, platform: string, version: string): Promise<Response> {
  const row = db.query(
    'SELECT filename, sha256 FROM client_versions WHERE platform = ? AND version = ?'
  ).get(platform, version) as any;

  if (!row) return json({ error: 'Version not found' }, 404);

  const path = join(CLIENTS_DIR, platform, row.filename);
  const file = Bun.file(path);

  if (!(await file.exists())) return json({ error: 'Binary not found on server' }, 404);

  return new Response(file, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${row.filename}"`,
      'X-SHA256': row.sha256,
    },
  });
}

export async function handlePublishVersion(req: Request): Promise<Response> {
  const deny = requireDeployKey(req);
  if (deny) return deny;

  // Expect multipart/form-data: version, platform, file, sha256
  const formData = await req.formData().catch(() => null);
  if (!formData) return json({ error: 'multipart/form-data required' }, 400);

  const version  = formData.get('version') as string;
  const platform = formData.get('platform') as Platform;
  const sha256   = formData.get('sha256') as string;
  const file     = formData.get('file') as File | null;

  if (!version || !platform || !sha256 || !file) {
    return json({ error: 'version, platform, sha256, and file are required' }, 400);
  }

  if (!PLATFORMS.includes(platform)) {
    return json({ error: `Invalid platform. Must be one of: ${PLATFORMS.join(', ')}` }, 400);
  }

  if (!/^\d+\.\d+\.\d+/.test(version)) {
    return json({ error: 'Version must follow semver (e.g. 1.2.3)' }, 400);
  }

  const platformDir = join(CLIENTS_DIR, platform);
  mkdirSync(platformDir, { recursive: true });

  const ext = platform.startsWith('windows') ? '.exe' : '';
  const filename = `fileshare-${platform}-${version}${ext}`;
  const destPath = join(platformDir, filename);

  await Bun.write(destPath, await file.arrayBuffer());

  // Verify sha256
  const written = await Bun.file(destPath).arrayBuffer();
  const buf = await crypto.subtle.digest('SHA-256', written);
  const actualHash = Buffer.from(buf).toString('hex');

  if (actualHash !== sha256) {
    const { rmSync } = await import('fs');
    rmSync(destPath, { force: true });
    return json({ error: 'SHA256 mismatch — upload rejected' }, 400);
  }

  // Mark previous latest as not latest for this platform
  db.query('UPDATE client_versions SET is_latest = 0 WHERE platform = ?').run(platform);

  db.query(
    'INSERT INTO client_versions (version, platform, filename, sha256, is_latest) VALUES (?, ?, ?, ?, 1) ON CONFLICT(version, platform) DO UPDATE SET filename = excluded.filename, sha256 = excluded.sha256, is_latest = 1'
  ).run(version, platform, filename, sha256);

  console.log(`[version] Published ${version} for ${platform}`);
  return json({ ok: true, version, platform, filename, sha256 }, 201);
}

export async function handleListVersions(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const platform = url.searchParams.get('platform');

  const query = platform
    ? 'SELECT version, platform, sha256, is_latest, created_at FROM client_versions WHERE platform = ? ORDER BY created_at DESC'
    : 'SELECT version, platform, sha256, is_latest, created_at FROM client_versions ORDER BY created_at DESC';

  const rows = platform
    ? db.query(query).all(platform)
    : db.query(query).all();

  return json({ versions: rows });
}
