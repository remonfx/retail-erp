import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { createHash, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { authenticator } from 'otplib';
import { config } from '../config.js';

const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 }; // OWASP 2023 minimum for Argon2id

export const hashPassword = (pw: string) => argonHash(pw, ARGON);
export const verifyPassword = async (h: string | null | undefined, pw: string) => (h ? argonVerify(h, pw).catch(() => false) : false);

export function validatePasswordStrength(pw: string): string | null {
  if (pw.length < 12) return 'PASSWORD_TOO_SHORT';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'PASSWORD_TOO_WEAK';
  return null;
}

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest();
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export function safeEqual(a: Buffer, b: Buffer) { return a.length === b.length && timingSafeEqual(a, b); }

const jwtKey = new TextEncoder().encode(config.jwtSecret);
export interface AccessClaims { sub: string; tid: string; mfa: boolean }

export async function signAccessToken(c: AccessClaims): Promise<string> {
  return new SignJWT({ tid: c.tid, mfa: c.mfa })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(c.sub).setIssuedAt()
    .setIssuer('retailcore').setAudience('retailcore-api')
    .setExpirationTime(`${config.accessTokenTtlSec}s`).sign(jwtKey);
}
export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, jwtKey, { issuer: 'retailcore', audience: 'retailcore-api' });
  return { sub: String(payload.sub), tid: String(payload.tid), mfa: Boolean(payload.mfa) };
}

// MFA secret encryption (AES-256-GCM)
const mfaKey = sha256(config.mfaEncryptionKey);
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', mfaKey, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}
export function decryptSecret(blob: string): string {
  const [iv, tag, enc] = blob.split('.').map((x) => Buffer.from(x, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', mfaKey, iv!);
  d.setAuthTag(tag!);
  return Buffer.concat([d.update(enc!), d.final()]).toString('utf8');
}
authenticator.options = { window: 1 };
export const newTotpSecret = () => authenticator.generateSecret();
export const totpUri = (email: string, secret: string) => authenticator.keyuri(email, 'RetailCore', secret);
export const verifyTotp = (secret: string, code: string) => authenticator.check(code, secret);
export const totpNow = (secret: string) => authenticator.generate(secret);
