/**
 * Documents: the supplier's PDF, a receipt, a signed contract. Bytes live in
 * the ledger's own schema so a tenant stays self-contained; links tie one
 * document to any number of things (a bill, an invoice, a journal, a bank
 * line). The same bytes uploaded twice are stored once per company.
 */
import { createHash } from 'node:crypto';
import { LedgerError } from './ledger.js';
import { newId, table, type LedgerDb } from './sql.js';

export const DOCUMENT_MAX_BYTES = 6 * 1024 * 1024;

export type DocumentTarget = 'bill' | 'invoice' | 'journal' | 'transaction' | 'statement_line' | 'supplier' | 'customer';

export interface DocumentMeta {
  id: string;
  publicId: string;
  companyId: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  kind: string;
  uploadedBy: string;
  createdAt: string;
  links: Array<{ targetKind: DocumentTarget; targetId: string }>;
}

const ALLOWED_MIME = /^(application\/pdf|image\/(png|jpeg|jpg|gif|webp|heic)|text\/(plain|csv)|application\/(json|vnd\.ms-excel|vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|msword|vnd\.openxmlformats-officedocument\.wordprocessingml\.document))$/i;

function cleanName(name: unknown): string {
  const s = String(name ?? '').trim().replace(/[\\/]/g, '_').slice(0, 200);
  return s || 'document';
}

/** Store a file (base64). Returns the existing record when the same bytes were stored before. */
export async function addDocument(
  db: LedgerDb,
  companyId: string,
  input: { filename: string; mime: string; contentBase64: string; uploadedBy?: string; kind?: string; link?: { targetKind: DocumentTarget; targetId: string } | null },
): Promise<DocumentMeta> {
  const mime = String(input.mime ?? '').trim().toLowerCase() || 'application/octet-stream';
  if (!ALLOWED_MIME.test(mime)) throw new LedgerError(`${mime} is not a file type the ledger stores (PDF, images, CSV, spreadsheets, Word)`, 'invalid');
  const b64 = String(input.contentBase64 ?? '').replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  if (!b64) throw new LedgerError('the file is empty', 'invalid');
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length === 0) throw new LedgerError('the file is empty', 'invalid');
  if (bytes.length > DOCUMENT_MAX_BYTES) throw new LedgerError(`files up to ${Math.round(DOCUMENT_MAX_BYTES / 1024 / 1024)} MB`, 'invalid');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const id = newId();
  const ins = await db.sql.execute(
    `INSERT INTO ${table(db, 'documents')} (id, public_id, company_id, filename, mime, size_bytes, sha256, kind, content, uploaded_by)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::int, $7, $8, decode($9, 'base64'), $10)
     ON CONFLICT (company_id, sha256) DO NOTHING`,
    [id, newId(), companyId, cleanName(input.filename), mime, bytes.length, sha, String(input.kind ?? 'attachment').slice(0, 40), bytes.toString('base64'), input.uploadedBy ?? 'board'],
  );
  let docId = id;
  if (ins.rowCount === 0) {
    const rows = await db.sql.query<{ id: string }>(`SELECT id FROM ${table(db, 'documents')} WHERE company_id = $1 AND sha256 = $2`, [companyId, sha]);
    if (!rows[0]) throw new LedgerError('document was not written', 'invalid');
    docId = rows[0].id;
  }
  if (input.link) await linkDocument(db, companyId, docId, input.link.targetKind, input.link.targetId);
  const doc = await getDocument(db, companyId, docId);
  if (!doc) throw new LedgerError('document was not written', 'invalid');
  return doc;
}

export async function linkDocument(db: LedgerDb, companyId: string, documentId: string, targetKind: DocumentTarget, targetId: string): Promise<void> {
  if (!targetId) throw new LedgerError('a link needs a target', 'invalid');
  await db.sql.execute(
    `INSERT INTO ${table(db, 'document_links')} (id, company_id, document_id, target_kind, target_id) VALUES (gen_random_uuid(), $1, $2::uuid, $3, $4)
     ON CONFLICT (document_id, target_kind, target_id) DO NOTHING`,
    [companyId, documentId, targetKind, String(targetId)],
  );
}

export async function unlinkDocument(db: LedgerDb, companyId: string, documentId: string, targetKind: DocumentTarget, targetId: string): Promise<void> {
  await db.sql.execute(`DELETE FROM ${table(db, 'document_links')} WHERE company_id = $1 AND document_id = $2::uuid AND target_kind = $3 AND target_id = $4`, [companyId, documentId, targetKind, String(targetId)]);
}

interface DocRow { id: string; public_id: string; company_id: string; filename: string; mime: string; size_bytes: number; sha256: string; kind: string; uploaded_by: string; created_at: string }

async function linksFor(db: LedgerDb, companyId: string, ids: string[]): Promise<Map<string, DocumentMeta['links']>> {
  const out = new Map<string, DocumentMeta['links']>();
  if (ids.length === 0) return out;
  const rows = await db.sql.query<{ document_id: string; target_kind: DocumentTarget; target_id: string }>(
    `SELECT document_id, target_kind, target_id FROM ${table(db, 'document_links')} WHERE company_id = $1 AND document_id = ANY(string_to_array($2::text, ',')::uuid[]) ORDER BY created_at`,
    [companyId, ids.join(',')],
  );
  for (const r of rows) {
    const list = out.get(r.document_id) ?? [];
    list.push({ targetKind: r.target_kind, targetId: r.target_id });
    out.set(r.document_id, list);
  }
  return out;
}

function fromRow(r: DocRow, links: DocumentMeta['links']): DocumentMeta {
  return { id: r.id, publicId: r.public_id, companyId: r.company_id, filename: r.filename, mime: r.mime, sizeBytes: Number(r.size_bytes), sha256: r.sha256, kind: r.kind, uploadedBy: r.uploaded_by, createdAt: r.created_at, links };
}

export async function getDocument(db: LedgerDb, companyId: string, id: string): Promise<DocumentMeta | null> {
  const rows = await db.sql.query<DocRow>(
    `SELECT id, public_id, company_id, filename, mime, size_bytes, sha256, kind, uploaded_by, created_at::text AS created_at FROM ${table(db, 'documents')} WHERE company_id = $1 AND id = $2::uuid`,
    [companyId, id],
  );
  const r = rows[0];
  if (!r) return null;
  const links = await linksFor(db, companyId, [id]);
  return fromRow(r, links.get(id) ?? []);
}

/** The bytes, base64. Kept separate from the metadata so lists stay light. */
export async function readDocument(db: LedgerDb, companyId: string, id: string): Promise<{ meta: DocumentMeta; contentBase64: string } | null> {
  const meta = await getDocument(db, companyId, id);
  if (!meta) return null;
  const rows = await db.sql.query<{ b64: string }>(`SELECT encode(content, 'base64') AS b64 FROM ${table(db, 'documents')} WHERE company_id = $1 AND id = $2::uuid`, [companyId, id]);
  return { meta, contentBase64: (rows[0]?.b64 ?? '').replace(/\s+/g, '') };
}

export async function listDocumentsFor(db: LedgerDb, companyId: string, targetKind: DocumentTarget, targetId: string): Promise<DocumentMeta[]> {
  const rows = await db.sql.query<DocRow>(
    `SELECT d.id, d.public_id, d.company_id, d.filename, d.mime, d.size_bytes, d.sha256, d.kind, d.uploaded_by, d.created_at::text AS created_at
       FROM ${table(db, 'document_links')} k JOIN ${table(db, 'documents')} d ON d.id = k.document_id
      WHERE k.company_id = $1 AND k.target_kind = $2 AND k.target_id = $3 ORDER BY d.created_at`,
    [companyId, targetKind, String(targetId)],
  );
  const links = await linksFor(db, companyId, rows.map((r) => r.id));
  return rows.map((r) => fromRow(r, links.get(r.id) ?? []));
}

/** Documents for many targets at once (a list screen). */
export async function documentCounts(db: LedgerDb, companyId: string, targetKind: DocumentTarget, targetIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (targetIds.length === 0) return out;
  const rows = await db.sql.query<{ target_id: string; n: unknown }>(
    `SELECT target_id, COUNT(*) AS n FROM ${table(db, 'document_links')} WHERE company_id = $1 AND target_kind = $2 AND target_id = ANY(string_to_array($3::text, ',')) GROUP BY target_id`,
    [companyId, targetKind, targetIds.join(',')],
  );
  for (const r of rows) out.set(r.target_id, Number(r.n));
  return out;
}
