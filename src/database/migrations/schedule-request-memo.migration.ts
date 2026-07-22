export const SCHEDULE_REQUEST_MEMO_MIGRATION_ID = '20260722_02_tbo47_schedule_request_memo';

/** 강사 스케줄 승인 요청의 메모를 승인 전후로 손실 없이 보존한다. */
export const SCHEDULE_REQUEST_MEMO_MIGRATION_SQL: readonly string[] = [
  `ALTER TABLE schedule_requests ADD COLUMN IF NOT EXISTS memo text`,
];
