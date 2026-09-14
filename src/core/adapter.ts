import { ACCOUNT } from './accounts.js';

/**
 * The platform boundary.
 *
 * Everything on the far side of this file is platform-specific (Paperclip
 * first). Everything on the near side is the ledger. The core never imports a
 * platform type; a platform adapter only ever hands the core `CostRecord`s.
 *
 * Acceptance criterion 11: the core compiles and its tests pass with every
 * adapter deleted. Keep this file free of platform imports.
 */
import type { Minor } from './sql.js';
import type { Subject } from './ledger.js';

/** What kind of spend a platform reported. Maps onto an expense account. */
export type CostCategory = 'model' | 'tool' | 'compute' | 'other';

/** A single platform-neutral cost, already in minor units. */
export interface CostRecord {
  /** Platform-unique id of the source record; becomes the idempotency key. */
  ref: string;
  occurredAt: Date;
  amountMinor: Minor;
  currency: string;
  category: CostCategory;
  /** Who charged it (a model provider, a tool vendor, a sandbox host). Display only. */
  biller?: string;
  /** Free text kept on the transaction. */
  description?: string;
  /** Whether the platform still considers the amount an estimate. */
  estimated?: boolean;
  subject?: Subject;
}

/**
 * An opaque, resumable position in a platform's cost stream.
 *
 * `lastOccurredAt` is a timestamp literal as text (whatever the platform's
 * database prints for `::text`), never a JS Date: a Date keeps milliseconds,
 * PostgreSQL keeps microseconds, and a cursor that loses precision re-reads
 * the same tail on every sweep.
 */
export interface CostCursor {
  lastEventRef: string | null;
  lastOccurredAt: string | null;
}

export interface CostBatch {
  records: CostRecord[];
  /** Cursor to persist after the batch is posted. Equal to the input cursor when nothing was read. */
  next: CostCursor;
}

/** Implemented once per platform. Read-only from the platform's point of view. */
export interface CostSource {
  readonly platform: string;
  /** Read up to `limit` costs strictly after the cursor, oldest first. */
  read(companyId: string, cursor: CostCursor, limit: number): Promise<CostBatch>;
}

/**
 * Category to expense account. A role rather than a number, because which
 * number carries model inference is a fact about the company's chart:
 * `postTransaction` turns it into that company's own code.
 *
 * Unknown falls through to other operating rather than being dropped.
 */
export function expenseAccountFor(category: CostCategory): string {
  switch (category) {
    case 'model':
      return ACCOUNT.MODEL_INFERENCE;
    case 'tool':
      return ACCOUNT.TOOLS_AND_APIS;
    case 'compute':
      return ACCOUNT.COMPUTE_AND_SANDBOXES;
    default:
      return ACCOUNT.OTHER_OPERATING;
  }
}
