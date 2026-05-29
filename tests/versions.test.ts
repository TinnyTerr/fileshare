import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { rmSync, mkdirSync } from 'fs';

const DEPLOY_KEY = 'test-deploy-key-versions';

process.env.DB_PATH        = './data/test-versions.db';
process.env.UPLOAD_DIR     = './data/test-ver-files';
process.env.TMP_DIR        = './data/test-ver-tmp';
process.env.JWT_SECRET     = 'test-secret-key-versions';
process.env.DEPLOY_API_KEY = DEPLOY_KEY;
process.env.SERVER_URL     = 'http://localhost:3103';

const BASE = 'http://localhost:3103';
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  mkdirSync('./data', { recursive: true });
  const { createServer } = await import('../server/app');
  server = createServer(3103);
  await Bun.sleep(50);
});

afterAll(() => {
  server?.stop(true);
  rmSync('./data/test-versions.db',  { force: true });
  rmSync('./data/test-ver-files',    { recursive: true, force: true });
  rmSync('./data/test-ver-tmp',      { recursive: true, force: true });
  rmSync('./data/clients',           { recursive: true, force: true });
});

describe('Version API', () => {
  const platform = 'linux-x64';
  const version  = '1.2.3';
  const binaryContent = new TextEncoder().encode('#!/bin/sh\necho hello');

  async function sha256(data: Uint8Array): Promise<string> {
    const buf = await crypto.subtle.digest('SHA-256', data.buffer as ArrayBuffer);
    return Buffer.from(buf).toString('hex');
  }

  it('returns 404 when no version published', async () => {
    const res = await fetch(`${BASE}/api/version?platform=${platform}`);
    expect(res.status).toBe(404);
  });

  it('rejects publish without deploy key', async () => {
    const form = new FormData();
    form.append('version', version);
    form.append('platform', platform);
    form.append('sha256', 'abc');
    form.append('file', new Blob([binaryContent]), 'fileshare-linux-x64');

    const res = await fetch(`${BASE}/api/version`, { method: 'POST', body: form });
    expect(res.status).toBe(401);
  });

  it('rejects publish with wrong sha256', async () => {
    const form = new FormData();
    form.append('version', version);
    form.append('platform', platform);
    form.append('sha256', 'wrong-hash');
    form.append('file', new Blob([binaryContent]), 'fileshare-linux-x64');

    const res = await fetch(`${BASE}/api/version`, {
      method: 'POST',
      headers: { 'X-Deploy-Key': DEPLOY_KEY },
      body: form,
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toContain('SHA256');
  });

  it('publishes a new version', async () => {
    const hash = await sha256(binaryContent);
    const form = new FormData();
    form.append('version', version);
    form.append('platform', platform);
    form.append('sha256', hash);
    form.append('file', new Blob([binaryContent]), 'fileshare-linux-x64');

    const res = await fetch(`${BASE}/api/version`, {
      method: 'POST',
      headers: { 'X-Deploy-Key': DEPLOY_KEY },
      body: form,
    });
    expect(res.status).toBe(201);
    const data = await res.json() as any;
    expect(data.version).toBe(version);
    expect(data.platform).toBe(platform);
  });

  it('returns latest version info with download_url', async () => {
    const res = await fetch(`${BASE}/api/version?platform=${platform}`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.version).toBe(version);
    expect(data.download_url).toContain(platform);
  });

  it('marks newer version as latest', async () => {
    const hash = await sha256(binaryContent);
    const form = new FormData();
    form.append('version', '2.0.0');
    form.append('platform', platform);
    form.append('sha256', hash);
    form.append('file', new Blob([binaryContent]), 'fileshare-linux-x64');

    await fetch(`${BASE}/api/version`, {
      method: 'POST',
      headers: { 'X-Deploy-Key': DEPLOY_KEY },
      body: form,
    });

    const res = await fetch(`${BASE}/api/version?platform=${platform}`);
    expect((await res.json() as any).version).toBe('2.0.0');
  });

  it('lists version history', async () => {
    const res = await fetch(`${BASE}/api/version/history?platform=${platform}`);
    expect(res.status).toBe(200);
    expect((await res.json() as any).versions.length).toBeGreaterThanOrEqual(2);
  });

  it('downloads published binary', async () => {
    const res = await fetch(`${BASE}/api/version/download/${platform}/${version}`);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(binaryContent);
  });
});
