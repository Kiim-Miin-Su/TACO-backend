// [TBO-77D-5] 공용 리포트 템플릿의 lifecycle owner. NULL 레거시/기본 템플릿은
// 관리자만 변경하고 신규 행은 JWT actor를 FK로 저장한다.
export const REPORT_TEMPLATE_OWNER_MIGRATION_ID = '20260729_06_tbo77_report_template_owner';

export const REPORT_TEMPLATE_OWNER_MIGRATION_SQL: readonly string[] = [
  `ALTER TABLE report_templates ADD COLUMN IF NOT EXISTS created_by integer`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_report_templates_created_by') THEN
       ALTER TABLE report_templates
         ADD CONSTRAINT fk_report_templates_created_by
         FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL NOT VALID;
     END IF;
   END $$`,
  `ALTER TABLE report_templates VALIDATE CONSTRAINT fk_report_templates_created_by`,
  `CREATE INDEX IF NOT EXISTS idx_report_templates_created_by_active
     ON report_templates (created_by, id) WHERE deleted_at IS NULL`,
];
