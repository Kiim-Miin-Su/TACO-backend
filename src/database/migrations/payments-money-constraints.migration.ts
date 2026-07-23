export const PAYMENTS_MONEY_CONSTRAINTS_MIGRATION_ID = '20260723_01_tbo53_payments_money_constraints';

/**
 * [TBO-53 C1 2026-07-23] 결제·원장 물리 무결성 — TBO-50 P0-2 "물리 payments에 FK/CHECK" 이행.
 *  앱 계층(lock+DB 재조회+CAS)의 최후 방어선: 참조(FK 4종)·금액 비음수·상태 enum을 DB가 강제한다.
 *  전부 멱등(conname/IF NOT EXISTS 검사) + 참조 표 존재 가드(런타임 ensureReady의 표 생성 순서 무관).
 *  사전 orphan 탐지: 활성 결제가 물리적으로 없는 학생/수강/보호자를 가리키면 적용을 중단한다(RAISE).
 */
export const PAYMENTS_MONEY_CONSTRAINTS_MIGRATION_SQL: readonly string[] = [
  // 0) 사전 orphan 탐지 — 물리 부재 참조가 있으면 데이터 교정(repair 청크) 전에는 적용 금지.
  //  ⚠ PL/pgSQL은 표현식 파싱 시 테이블 참조를 해석하므로 존재 가드는 반드시 **중첩 IF**로 분리한다
  //  (같은 IF의 AND 조건에 넣으면 미존재 표에서 파싱 오류 — fresh DB 부팅 순서 함정, C1 실측).
  `DO $$
   BEGIN
     IF to_regclass('public.payments') IS NULL OR to_regclass('public.students') IS NULL THEN RETURN; END IF;
     IF EXISTS (SELECT 1 FROM payments p LEFT JOIN students s ON s.id = p.student_id
                WHERE p.student_id IS NOT NULL AND s.id IS NULL) THEN
       RAISE EXCEPTION 'payments.student_id orphan rows exist — repair before adding FK';
     END IF;
     IF to_regclass('public.enrollments') IS NOT NULL THEN
       IF EXISTS (SELECT 1 FROM payments p LEFT JOIN enrollments e ON e.id = p.enrollment_id
                  WHERE p.enrollment_id IS NOT NULL AND e.id IS NULL) THEN
         RAISE EXCEPTION 'payments.enrollment_id orphan rows exist — repair before adding FK';
       END IF;
     END IF;
     IF to_regclass('public.parents') IS NOT NULL THEN
       IF EXISTS (SELECT 1 FROM payments p LEFT JOIN parents g ON g.id = p.payer_parent_id
                  WHERE p.payer_parent_id IS NOT NULL AND g.id IS NULL) THEN
         RAISE EXCEPTION 'payments.payer_parent_id orphan rows exist — repair before adding FK';
       END IF;
     END IF;
   END $$`,
  // 1) FK 3종 — 참조 무결성(soft delete 정책과 공존: 참조 행은 물리 보존되므로 FK는 물리 존재만 강제).
  `DO $$
   BEGIN
     IF to_regclass('public.payments') IS NULL THEN RETURN; END IF;
     IF to_regclass('public.students') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_payments_student') THEN
       ALTER TABLE payments ADD CONSTRAINT fk_payments_student
         FOREIGN KEY (student_id) REFERENCES students(id);
     END IF;
     IF to_regclass('public.enrollments') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_payments_enrollment') THEN
       ALTER TABLE payments ADD CONSTRAINT fk_payments_enrollment
         FOREIGN KEY (enrollment_id) REFERENCES enrollments(id);
     END IF;
     IF to_regclass('public.parents') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_payments_payer_parent') THEN
       ALTER TABLE payments ADD CONSTRAINT fk_payments_payer_parent
         FOREIGN KEY (payer_parent_id) REFERENCES parents(id);
     END IF;
   END $$`,
  // 2) CHECK — 금액 비음수·상태 enum(contracts PaymentStatus와 동일 집합).
  `DO $$
   BEGIN
     IF to_regclass('public.payments') IS NULL THEN RETURN; END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='c_payments_amount_nonneg') THEN
       ALTER TABLE payments ADD CONSTRAINT c_payments_amount_nonneg CHECK (amount >= 0);
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='c_payments_paid_amount_nonneg') THEN
       ALTER TABLE payments ADD CONSTRAINT c_payments_paid_amount_nonneg CHECK (paid_amount >= 0);
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='c_payments_status_enum') THEN
       ALTER TABLE payments ADD CONSTRAINT c_payments_status_enum
         CHECK (status IN ('pending','paid','overdue','refunded','partial_refund'));
     END IF;
   END $$`,
];

/** 원장 역참조 FK — payments/transactions 양쪽 spec.migrations에 포함(표 생성 순서 무관 적용). */
export const TRANSACTIONS_PAYMENT_FK_SQL = `DO $$
   BEGIN
     IF to_regclass('public.transactions') IS NULL OR to_regclass('public.payments') IS NULL THEN RETURN; END IF;
     IF EXISTS (SELECT 1 FROM transactions t LEFT JOIN payments p ON p.id = t.payment_id
                WHERE t.payment_id IS NOT NULL AND p.id IS NULL) THEN
       RAISE EXCEPTION 'transactions.payment_id orphan rows exist — repair before adding FK';
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_transactions_payment') THEN
       ALTER TABLE transactions ADD CONSTRAINT fk_transactions_payment
         FOREIGN KEY (payment_id) REFERENCES payments(id);
     END IF;
   END $$`;

/** ledger(20260723_01) 적용용 전체 SQL — 운영(Neon) migrate 스크립트가 이 목록을 순서대로 실행한다. */
export const PAYMENTS_MONEY_CONSTRAINTS_LEDGER_SQL: readonly string[] = [
  ...PAYMENTS_MONEY_CONSTRAINTS_MIGRATION_SQL,
  TRANSACTIONS_PAYMENT_FK_SQL,
];
