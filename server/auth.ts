import { SignJWT, jwtVerify } from 'jose';
import type { TokenPayload } from '../shared/types';

const secret = new TextEncoder().encode(
  process.env.JWT_SECRET || 'change-this-to-a-long-random-secret'
);

export async function signAccessToken(payload: TokenPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(secret);
}

export async function verifyAccessToken(token: string): Promise<TokenPayload> {
  const { payload } = await jwtVerify(token, secret);
  return payload as unknown as TokenPayload;
}

export function generateRefreshToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
}

export function refreshTokenExpiry(): string {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return d.toISOString();
}
