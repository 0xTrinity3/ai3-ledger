/**
 * Sealing exchange credentials at rest.
 *
 * AES-256-GCM under one key per plugin database. The key comes from the
 * AI3_LEDGER_SECRET environment variable when the host passes one to the
 * worker; otherwise a random key is generated once and kept in the
 * ledger_vault table. The second case protects the credentials table from
 * casual reads and backups copied around, not from someone holding the whole
 * database, which is why the ledger only accepts read-only exchange keys.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { ensureVaultKey, type LedgerDb } from '../core/index.js';

async function keyFor(db: LedgerDb): Promise<Buffer> {
  const env = process.env['AI3_LEDGER_SECRET'];
  if (env && env.trim()) return createHash('sha256').update(env.trim()).digest();
  const b64 = await ensureVaultKey(db, () => randomBytes(32).toString('base64'));
  return Buffer.from(b64, 'base64');
}

export async function seal(db: LedgerDb, plaintext: string): Promise<string> {
  const key = await keyFor(db);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${ct.toString('base64')}`;
}

export async function unseal(db: LedgerDb, blob: string): Promise<string> {
  const [v, iv, tag, ct] = blob.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('sealed credentials are malformed');
  const key = await keyFor(db);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}
