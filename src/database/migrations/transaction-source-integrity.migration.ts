export const TRANSACTION_SOURCE_INTEGRITY_MIGRATION_ID =
  '20260729_05_tbo77_transaction_source_integrity';

export const TRANSACTION_SOURCE_CONSTRAINTS = [
  'fk_transactions_payment',
  'fk_transactions_payout',
  'fk_transactions_expense',
  'c_transactions_exactly_one_source',
] as const;

export const TRANSACTION_SOURCE_INTEGRITY_SQL: readonly string[] = [
  `DO $$
   DECLARE bad integer;
   BEGIN
     IF to_regclass('public.transactions') IS NULL THEN RAISE EXCEPTION 'transactions table is missing'; END IF;
     IF to_regclass('public.payments') IS NULL
        OR to_regclass('public.instructor_payouts') IS NULL
        OR to_regclass('public.expenses') IS NULL THEN RETURN; END IF;
     SELECT COUNT(*) INTO bad
       FROM transactions
      WHERE ((payment_id IS NOT NULL)::integer
           + (payout_id IS NOT NULL)::integer
           + (expense_id IS NOT NULL)::integer) <> 1;
     IF bad > 0 THEN RAISE EXCEPTION 'transactions invalid source count % rows', bad; END IF;

     SELECT COUNT(*) INTO bad FROM transactions t LEFT JOIN payments p ON p.id=t.payment_id
      WHERE t.payment_id IS NOT NULL AND p.id IS NULL;
     IF bad > 0 THEN RAISE EXCEPTION 'transactions payment orphan % rows', bad; END IF;
     SELECT COUNT(*) INTO bad FROM transactions t LEFT JOIN instructor_payouts p ON p.id=t.payout_id
      WHERE t.payout_id IS NOT NULL AND p.id IS NULL;
     IF bad > 0 THEN RAISE EXCEPTION 'transactions payout orphan % rows', bad; END IF;
     SELECT COUNT(*) INTO bad FROM transactions t LEFT JOIN expenses e ON e.id=t.expense_id
      WHERE t.expense_id IS NOT NULL AND e.id IS NULL;
     IF bad > 0 THEN RAISE EXCEPTION 'transactions expense orphan % rows', bad; END IF;
   END $$`,
  `DO $$
   BEGIN
     IF to_regclass('public.payments') IS NULL
        OR to_regclass('public.instructor_payouts') IS NULL
        OR to_regclass('public.expenses') IS NULL THEN RETURN; END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_transactions_payment' AND conrelid='public.transactions'::regclass) THEN
       ALTER TABLE transactions ADD CONSTRAINT fk_transactions_payment FOREIGN KEY (payment_id) REFERENCES payments(id) NOT VALID;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_transactions_payout' AND conrelid='public.transactions'::regclass) THEN
       ALTER TABLE transactions ADD CONSTRAINT fk_transactions_payout FOREIGN KEY (payout_id) REFERENCES instructor_payouts(id) NOT VALID;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_transactions_expense' AND conrelid='public.transactions'::regclass) THEN
       ALTER TABLE transactions ADD CONSTRAINT fk_transactions_expense FOREIGN KEY (expense_id) REFERENCES expenses(id) NOT VALID;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='c_transactions_exactly_one_source' AND conrelid='public.transactions'::regclass) THEN
       ALTER TABLE transactions ADD CONSTRAINT c_transactions_exactly_one_source
         CHECK (((payment_id IS NOT NULL)::integer + (payout_id IS NOT NULL)::integer + (expense_id IS NOT NULL)::integer) = 1) NOT VALID;
     END IF;
   END $$`,
  `DO $$
   DECLARE constraint_row record;
   BEGIN
     FOR constraint_row IN
       SELECT conname FROM pg_constraint
        WHERE conrelid='public.transactions'::regclass
          AND conname = ANY(ARRAY['fk_transactions_payment','fk_transactions_payout','fk_transactions_expense','c_transactions_exactly_one_source'])
          AND NOT convalidated
     LOOP
       EXECUTE format('ALTER TABLE transactions VALIDATE CONSTRAINT %I', constraint_row.conname);
     END LOOP;
   END $$`,
];
