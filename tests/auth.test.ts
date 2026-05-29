import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { rmSync, mkdirSync } from 'fs';

process.env.DB_PATH        = './data/test-auth.db';
process.env.UPLOAD_DIR     = './data/test-auth-files';
process.env.TMP_DIR        = './data/test-auth-tmp';
process.env.JWT_SECRET     = 'test-secret-key-auth';
process.env.DEPLOY_API_KEY = 'test-deploy-key';

const BASE = 'http://localhost:3101';
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  mkdirSync('./data', { recursive: true });
  const { createServer } = await import('../server/app');
  server = createServer(3101);
  await Bun.sleep(50);
});

afterAll(() => {
  server?.stop(true);
  rmSync('./data/test-auth.db',       { force: true });
  rmSync('./data/test-auth-files',    { recursive: true, force: true });
  rmSync('./data/test-auth-tmp',      { recursive: true, force: true });
});

const username = `test_auth_${Date.now()}`;
const password = 'password123';
let accessToken = '';
let refreshToken = '';

describe('Auth', () => {
  it('registers a new user', async () => {
    const res = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    expect(res.status).toBe(201);
    const data = await res.json() as any;
    expect(data.user.username).toBe(username);
    expect(data.access_token).toBeString();
    expect(data.refresh_token).toBeString();
    accessToken = data.access_token;
    refreshToken = data.refresh_token;
  });

  it('rejects duplicate registration', async () => {
    const res = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    expect(res.status).toBe(409);
  });

  it('logs in with correct credentials', async () => {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.access_token).toBeString();
    accessToken = data.access_token;
    refreshToken = data.refresh_token;
  });

  it('rejects wrong password', async () => {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'wrong' }),
    });
    expect(res.status).toBe(401);
  });

  it('gets current user via /me', async () => {
    const res = await fetch(`${BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(200);
    const user = await res.json() as any;
    expect(user.username).toBe(username);
  });

  it('refreshes tokens', async () => {
    const res = await fetch(`${BASE}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.access_token).toBeString();
    expect(data.refresh_token).not.toBe(refreshToken); // rotated
    accessToken = data.access_token;
    refreshToken = data.refresh_token;
  });

  it('rejects a stale refresh token', async () => {
    const res = await fetch(`${BASE}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: 'definitely-invalid' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects requests with no token', async () => {
    const res = await fetch(`${BASE}/api/auth/me`);
    expect(res.status).toBe(401);
  });
});
