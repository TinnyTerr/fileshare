import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { rmSync, mkdirSync } from 'fs';
import { CHUNK_SIZE } from '../shared/types';

process.env.DB_PATH        = './data/test-files.db';
process.env.UPLOAD_DIR     = './data/test-upload-files';
process.env.TMP_DIR        = './data/test-upload-tmp';
process.env.JWT_SECRET     = 'test-secret-key-files';
process.env.DEPLOY_API_KEY = 'test-deploy-key-files';

const BASE = 'http://localhost:3102';
let server: ReturnType<typeof Bun.serve>;
let accessToken = '';
let fileId = '';

const username    = `files_${Date.now()}`;
const password = 'password123';

beforeAll(async () => {
  mkdirSync('./data', { recursive: true });
  const { createServer } = await import('../server/app');
  server = createServer(3102);
  await Bun.sleep(50);

  const res = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json() as any;
  accessToken = data.access_token;
});

afterAll(() => {
  server?.stop(true);
  rmSync('./data/test-files.db',       { force: true });
  rmSync('./data/test-upload-files',   { recursive: true, force: true });
  rmSync('./data/test-upload-tmp',     { recursive: true, force: true });
});

function auth() {
  return { Authorization: `Bearer ${accessToken}` };
}

describe('File upload/download', () => {
  const content = crypto.getRandomValues(new Uint8Array(512 * 1024)); // 512KB

  it('initiates a file upload', async () => {
    const res = await fetch(`${BASE}/api/files`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'test.bin', size: content.byteLength }),
    });
    expect(res.status).toBe(201);
    const data = await res.json() as any;
    expect(data.file_id).toBeString();
    expect(data.chunk_size).toBe(CHUNK_SIZE);
    fileId = data.file_id;
  });

  it('rejects chunk exceeding 100MB via Content-Range header', async () => {
    const fileSize = CHUNK_SIZE + 1024;
    const initRes = await fetch(`${BASE}/api/files`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'huge.bin', size: fileSize }),
    });
    const { file_id: bigId } = await initRes.json() as any;

    // Send a tiny body but claim it spans CHUNK_SIZE+1 bytes in Content-Range
    // Server must reject based on Content-Range before reading the body
    const tinyBody = new Uint8Array(16);
    const putRes = await fetch(`${BASE}/api/files/${bigId}/data`, {
      method: 'PUT',
      headers: {
        ...auth(),
        'Content-Range': `bytes 0-${CHUNK_SIZE}/${fileSize}`,
        'Content-Type': 'application/octet-stream',
      },
      body: tinyBody,
    });
    expect(putRes.status).toBe(413);
    expect((await putRes.json() as any).code).toBe('CHUNK_TOO_LARGE');
  });

  it('uploads a single chunk', async () => {
    const res = await fetch(`${BASE}/api/files/${fileId}/data`, {
      method: 'PUT',
      headers: {
        ...auth(),
        'Content-Range': `bytes 0-${content.byteLength - 1}/${content.byteLength}`,
        'Content-Type': 'application/octet-stream',
      },
      body: content.buffer as ArrayBuffer,
    });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.complete).toBe(true);
  });

  it('lists files', async () => {
    const res = await fetch(`${BASE}/api/files`, { headers: auth() });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.files.some((f: any) => f.id === fileId)).toBe(true);
  });

  it('gets file metadata', async () => {
    const res = await fetch(`${BASE}/api/files/${fileId}`, { headers: auth() });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.status).toBe('complete');
  });

  it('downloads with Range header (206)', async () => {
    const end = Math.min(999, content.byteLength - 1);
    const res = await fetch(`${BASE}/api/files/${fileId}/data`, {
      headers: { ...auth(), Range: `bytes=0-${end}` },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toContain(`bytes 0-${end}/`);
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf.length).toBe(end + 1);
  });

  it('rejects Range request exceeding 100MB', async () => {
    const res = await fetch(`${BASE}/api/files/${fileId}/data`, {
      headers: { ...auth(), Range: `bytes=0-${CHUNK_SIZE}` },
    });
    expect(res.status).toBe(413);
    expect((await res.json() as any).code).toBe('RANGE_TOO_LARGE');
  });

  it('shares file read-only with another user', async () => {
    const username2 = `share2_${Date.now()}@example.com`;
    const reg = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username2, password }),
    });
    const { access_token: tok2 } = await reg.json() as any;

    await fetch(`${BASE}/api/files/${fileId}/share`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username2 }),
    });

    const dlRes = await fetch(`${BASE}/api/files/${fileId}/data`, {
      headers: { Authorization: `Bearer ${tok2}`, Range: 'bytes=0-99' },
    });
    expect(dlRes.status).toBe(206);
  });

  it('deletes file', async () => {
    const res = await fetch(`${BASE}/api/files/${fileId}`, { method: 'DELETE', headers: auth() });
    expect(res.status).toBe(200);
    const check = await fetch(`${BASE}/api/files/${fileId}`, { headers: auth() });
    expect(check.status).toBe(404);
  });
});
