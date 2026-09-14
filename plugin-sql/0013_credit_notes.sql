-- A credit note is not a payment.
--
-- Until now the only way to reduce an invoice was to receive money against it
-- or to write the whole thing off. A partial credit — which is what a dispute
-- ruling produces, and what anybody issues when they overbill — had nowhere to
-- go, so it was being done as a "payment" and the books then said cash had
-- arrived that never did.
--
-- The relief row carries its kind. A payment debits cash; a credit debits the
-- income back out. Both relieve the receivable, and only one of them is money.
ALTER TABLE __NS__.invoice_payments ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'payment';
ALTER TABLE __NS__.invoice_payments DROP CONSTRAINT IF EXISTS invoice_payments_kind_check;
ALTER TABLE __NS__.invoice_payments ADD CONSTRAINT invoice_payments_kind_check CHECK (kind IN ('payment', 'credit'));

-- What the credit was for, in the words of whoever issued it. A credit with no
-- reason on it is the kind of adjustment that is impossible to defend later.
ALTER TABLE __NS__.invoice_payments ADD COLUMN IF NOT EXISTS reason text;
