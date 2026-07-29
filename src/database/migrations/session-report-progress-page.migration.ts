export const SESSION_REPORT_PROGRESS_PAGE_MIGRATION_ID =
  '20260729_01_tbo76_session_report_progress_page';

/**
 * [TBO-76 76D] 작성자가 입력하는 진도 페이지를 독립 nullable 컬럼으로 자산화한다.
 * 학생/학년/수업일/과목/시간은 기존 FK를 조인한 읽기 모델이 권위이므로 복제 컬럼을 추가하지 않는다.
 */
export const SESSION_REPORT_PROGRESS_PAGE_MIGRATION_SQL: readonly string[] = [
  `ALTER TABLE session_reports ADD COLUMN IF NOT EXISTS progress_page text`,
];
