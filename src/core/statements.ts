/**
 * Statement reading. Turns whatever a bank exported into statement lines.
 *
 * Deterministic readers cover OFX/QFX/QBO and CSV in any column order, with
 * dates in the common formats. They are meant to succeed on real bank files
 * without a mapping wizard; when they cannot, the caller may hand the file to a
 * model with the same output shape. Nothing here touches the database.
 */

export interface ParsedLine {
  postedAt: string; // ISO date, midday UTC so day boundaries are stable
  amountMinor: bigint; // signed: money in positive, money out negative
  description: string;
  payee?: string;
  reference?: string;
  externalId?: string;
  balanceAfterMinor?: bigint;
}

export interface ParsedStatement {
  format: 'ofx' | 'csv';
  lines: ParsedLine[];
  /** How the columns were read, so the confirmation screen can say it. */
  reading: string;
  currency?: string;
  from?: string;
  to?: string;
  closingBalanceMinor?: bigint;
  warnings: string[];
}

export class StatementError extends Error {}

// ---------------------------------------------------------------------------
// Money and dates
// ---------------------------------------------------------------------------

/** "1,234.56", "(12.00)", "-12,00", "€ 12.30", "12.30 CR" → signed minor units. */
export function parseMoney(raw: string): bigint | null {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  let sign = 1n;
  if (/^\(.*\)$/.test(s)) { sign = -1n; s = s.slice(1, -1); }
  if (/\bDR\b/i.test(s)) sign = -1n;
  s = s.replace(/\b(CR|DR)\b/gi, '').replace(/[^\d,.\-+]/g, '');
  if (s.startsWith('-')) { sign = sign * -1n; s = s.slice(1); }
  if (s.startsWith('+')) s = s.slice(1);
  if (!s) return null;
  // decide the decimal separator: the last of . or , if followed by 1-2 digits
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let whole = s;
  let frac = '';
  const sep = Math.max(lastDot, lastComma);
  if (sep >= 0 && s.length - sep - 1 <= 2) {
    whole = s.slice(0, sep);
    frac = s.slice(sep + 1);
  }
  whole = whole.replace(/[.,]/g, '');
  if (!/^\d*$/.test(whole) || !/^\d{0,2}$/.test(frac)) return null;
  const minor = BigInt(whole || '0') * 100n + BigInt((frac + '00').slice(0, 2));
  return sign * minor;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

export type DateOrder = 'ymd' | 'dmy' | 'mdy';

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString();
}

/** Parse one date with a known order. Handles 2026-09-01, 01/09/2026, 1 Sep 2026, 20260901, Sep 1, 2026. */
export function parseDate(raw: string, order: DateOrder): string | null {
  const s = String(raw ?? '').trim();
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) return iso(+m[1]!, +m[2]!, +m[3]!);
  if ((m = /^(\d{4})(\d{2})(\d{2})/.exec(s))) return iso(+m[1]!, +m[2]!, +m[3]!);
  if ((m = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/.exec(s))) {
    const y = m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!;
    return order === 'mdy' ? iso(y, +m[1]!, +m[2]!) : iso(y, +m[2]!, +m[1]!);
  }
  if ((m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(s))) {
    const mo = MONTHS[m[2]!.slice(0, 4).toLowerCase()] ?? MONTHS[m[2]!.slice(0, 3).toLowerCase()];
    return mo ? iso(+m[3]!, mo, +m[1]!) : null;
  }
  if ((m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s))) {
    const mo = MONTHS[m[1]!.slice(0, 4).toLowerCase()] ?? MONTHS[m[1]!.slice(0, 3).toLowerCase()];
    return mo ? iso(+m[3]!, mo, +m[2]!) : null;
  }
  return null;
}

/**
 * Decide day-first or month-first from a column of dates. First whichever
 * order makes every value valid; when both do, the order whose dates sit
 * closest to today without running into the future (statements are recent);
 * then day-first, as most of the world writes it.
 */
export function detectDateOrder(values: string[], now: Date = new Date()): DateOrder {
  const slashy = values.map((v) => v.trim()).filter((v) => /^\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}$/.test(v));
  if (slashy.length === 0) return 'ymd';
  const dmyOk = slashy.every((v) => parseDate(v, 'dmy'));
  const mdyOk = slashy.every((v) => parseDate(v, 'mdy'));
  if (dmyOk && !mdyOk) return 'dmy';
  if (mdyOk && !dmyOk) return 'mdy';
  if (!dmyOk && !mdyOk) return 'dmy';
  const horizon = now.getTime() + 7 * 86_400_000;
  const score = (order: DateOrder): number => {
    const ts = slashy.map((v) => Date.parse(parseDate(v, order)!));
    const latest = Math.max(...ts);
    if (latest > horizon) return Number.POSITIVE_INFINITY; // in the future: unlikely
    return now.getTime() - latest; // smaller is more recent
  };
  const d = score('dmy');
  const m = score('mdy');
  if (m < d) return 'mdy';
  return 'dmy';
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export function splitCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, '');
  const firstLine = clean.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  const delimiter = [',', ';', '\t', '|'].map((d) => ({ d, n: firstLine.split(d).length })).sort((a, b) => b.n - a.n)[0]!.d;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]!;
    if (quoted) {
      if (c === '"' && clean[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && clean[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

const H = {
  date: /^(date|transaction date|posted|posting date|value date|booking date|trans date|txn date|date posted|completed date|started date)$/i,
  amount: /^(amount|value|transaction amount|amount \(?[a-z]{3}\)?|net|sum)$/i,
  debit: /^(debit|debit amount|money out|paid out|withdrawal|withdrawals|out|spent|expense)$/i,
  credit: /^(credit|credit amount|money in|paid in|deposit|deposits|in|received|income)$/i,
  description: /^(description|details|narrative|memo|transaction|transaction description|name|particulars|text|title)$/i,
  payee: /^(payee|merchant|counterparty|counter party|beneficiary|to|from|name of counterparty|merchant name)$/i,
  reference: /^(reference|ref|reference number|transaction reference|memo\/reference|notes|note)$/i,
  balance: /^(balance|running balance|closing balance|balance after|balance \(?[a-z]{3}\)?)$/i,
  id: /^(id|transaction id|txn id|transaction number|fitid|unique id|external id)$/i,
};

function findCol(headers: string[], re: RegExp): number {
  return headers.findIndex((h) => re.test(h.trim()));
}

export function parseCsvStatement(text: string, opts: { dateOrder?: DateOrder } = {}): ParsedStatement {
  const rows = splitCsv(text);
  if (rows.length < 2) throw new StatementError('The file has no rows to read');
  // Header row: the first row whose cells are mostly non-numeric words.
  let headerIdx = rows.findIndex((r) => r.filter((c) => c.trim()).length >= 2 && r.every((c) => parseMoney(c) === null || /[A-Za-z]/.test(c)));
  if (headerIdx < 0) headerIdx = 0;
  const headers = rows[headerIdx]!.map((h) => h.trim().replace(/^"|"$/g, ''));
  const body = rows.slice(headerIdx + 1);
  const warnings: string[] = [];

  let dateCol = findCol(headers, H.date);
  let amountCol = findCol(headers, H.amount);
  const debitCol = findCol(headers, H.debit);
  const creditCol = findCol(headers, H.credit);
  let descCol = findCol(headers, H.description);
  const payeeCol = findCol(headers, H.payee);
  const refCol = findCol(headers, H.reference);
  const balCol = findCol(headers, H.balance);
  const idCol = findCol(headers, H.id);

  // Fall back to sniffing by content when the headers are unfamiliar.
  const sample = body.slice(0, 20);
  if (dateCol < 0) dateCol = headers.findIndex((_, i) => sample.filter((r) => r[i] && parseDate(r[i]!, 'dmy')).length >= Math.max(1, sample.length * 0.7));
  if (amountCol < 0 && debitCol < 0 && creditCol < 0) {
    const numeric = headers.map((_, i) => ({ i, n: sample.filter((r) => r[i] && parseMoney(r[i]!) !== null && !/[A-Za-z]{3,}/.test(r[i]!)).length })).filter((x) => x.i !== dateCol && x.n >= Math.max(1, sample.length * 0.7));
    if (numeric.length > 0) amountCol = numeric[0]!.i;
  }
  if (descCol < 0) {
    const texty = headers.map((_, i) => ({ i, n: sample.filter((r) => r[i] && /[A-Za-z]{3,}/.test(r[i]!)).length })).filter((x) => x.i !== dateCol && x.i !== amountCol && x.i !== payeeCol && x.n >= Math.max(1, sample.length * 0.5));
    if (texty.length > 0) descCol = texty.sort((a, b) => b.n - a.n)[0]!.i;
  }
  if (dateCol < 0) throw new StatementError(`No date column found among: ${headers.join(', ')}`);
  if (amountCol < 0 && debitCol < 0 && creditCol < 0) throw new StatementError(`No amount column found among: ${headers.join(', ')}`);
  if (descCol < 0 && payeeCol < 0) throw new StatementError(`No description column found among: ${headers.join(', ')}`);

  const order = opts.dateOrder ?? detectDateOrder(body.map((r) => r[dateCol] ?? ''));
  // Some banks write outgoing amounts as positive under a "Debit" column, others as negative in one column.
  const lines: ParsedLine[] = [];
  let skipped = 0;
  for (const r of body) {
    const postedAt = parseDate(r[dateCol] ?? '', order);
    let amount: bigint | null = null;
    if (amountCol >= 0) amount = parseMoney(r[amountCol] ?? '');
    else {
      const d = debitCol >= 0 ? parseMoney(r[debitCol] ?? '') : null;
      const c = creditCol >= 0 ? parseMoney(r[creditCol] ?? '') : null;
      if (d !== null && d !== 0n) amount = -(d < 0n ? -d : d);
      else if (c !== null) amount = c < 0n ? -c : c;
    }
    if (!postedAt || amount === null) { skipped++; continue; }
    const description = [descCol >= 0 ? r[descCol] : '', payeeCol >= 0 && descCol < 0 ? r[payeeCol] : ''].filter(Boolean).join(' ').trim();
    const line: ParsedLine = { postedAt, amountMinor: amount, description: description || (payeeCol >= 0 ? String(r[payeeCol] ?? '') : '') };
    if (payeeCol >= 0 && r[payeeCol]) line.payee = r[payeeCol]!.trim();
    if (refCol >= 0 && r[refCol]) line.reference = r[refCol]!.trim();
    if (idCol >= 0 && r[idCol]) line.externalId = r[idCol]!.trim();
    if (balCol >= 0) {
      const b = parseMoney(r[balCol] ?? '');
      if (b !== null) line.balanceAfterMinor = b;
    }
    lines.push(line);
  }
  if (lines.length === 0) throw new StatementError('No line in the file had both a date and an amount');
  if (skipped > 0) warnings.push(`${skipped} row${skipped === 1 ? '' : 's'} skipped: no date or amount`);

  const sorted = [...lines].sort((a, b) => a.postedAt.localeCompare(b.postedAt));
  const last = sorted[sorted.length - 1]!;
  const reading = [
    `date from "${headers[dateCol]}" (${order === 'dmy' ? 'day-month-year' : order === 'mdy' ? 'month-day-year' : 'year-month-day'})`,
    amountCol >= 0 ? `amount from "${headers[amountCol]}"` : `money out from "${headers[debitCol] ?? ''}", money in from "${headers[creditCol] ?? ''}"`,
    descCol >= 0 ? `description from "${headers[descCol]}"` : `description from "${headers[payeeCol]}"`,
  ].join('; ');
  return {
    format: 'csv',
    lines: sorted,
    reading,
    from: sorted[0]!.postedAt.slice(0, 10),
    to: last.postedAt.slice(0, 10),
    ...(last.balanceAfterMinor !== undefined ? { closingBalanceMinor: last.balanceAfterMinor } : {}),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// OFX / QFX / QBO (SGML or XML flavours)
// ---------------------------------------------------------------------------

function ofxTag(block: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>\\s*([^<\\r\\n]*)`, 'i').exec(block);
  return m ? m[1]!.trim() : undefined;
}

export function parseOfxStatement(text: string): ParsedStatement {
  const blocks = text.split(/<STMTTRN>/i).slice(1);
  if (blocks.length === 0) throw new StatementError('No <STMTTRN> entries in the OFX file');
  const lines: ParsedLine[] = [];
  const warnings: string[] = [];
  for (const b of blocks) {
    const dt = ofxTag(b, 'DTPOSTED') ?? '';
    const postedAt = parseDate(dt.slice(0, 8), 'ymd');
    const amount = parseMoney(ofxTag(b, 'TRNAMT') ?? '');
    if (!postedAt || amount === null) { warnings.push('one entry skipped: bad date or amount'); continue; }
    const name = ofxTag(b, 'NAME');
    const memo = ofxTag(b, 'MEMO');
    const line: ParsedLine = { postedAt, amountMinor: amount, description: [name, memo].filter(Boolean).join(' · ') || (ofxTag(b, 'TRNTYPE') ?? '') };
    if (name) line.payee = name;
    const ref = ofxTag(b, 'CHECKNUM') ?? ofxTag(b, 'REFNUM');
    if (ref) line.reference = ref;
    const fitid = ofxTag(b, 'FITID');
    if (fitid) line.externalId = fitid;
    lines.push(line);
  }
  if (lines.length === 0) throw new StatementError('No readable entries in the OFX file');
  const sorted = lines.sort((a, b) => a.postedAt.localeCompare(b.postedAt));
  const currency = ofxTag(text, 'CURDEF');
  const bal = parseMoney(ofxTag(text, 'BALAMT') ?? '');
  return {
    format: 'ofx',
    lines: sorted,
    reading: 'OFX: date from DTPOSTED, amount from TRNAMT, description from NAME and MEMO, id from FITID',
    ...(currency ? { currency } : {}),
    from: sorted[0]!.postedAt.slice(0, 10),
    to: sorted[sorted.length - 1]!.postedAt.slice(0, 10),
    ...(bal !== null ? { closingBalanceMinor: bal } : {}),
    warnings,
  };
}

/** Pick a reader from the content, not the extension. */
export function parseStatement(text: string, filename = '', opts: { dateOrder?: DateOrder } = {}): ParsedStatement {
  if (/<OFX>|<STMTTRN>|OFXHEADER/i.test(text) || /\.(ofx|qfx|qbo)$/i.test(filename)) return parseOfxStatement(text);
  return parseCsvStatement(text, opts);
}
