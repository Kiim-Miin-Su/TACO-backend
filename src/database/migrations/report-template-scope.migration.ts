export const REPORT_TEMPLATE_SCOPE_MIGRATION_ID =
  '20260806_05_tbo86_report_template_scope';

export const REPORT_TEMPLATE_SCOPE_CONSTRAINT =
  'c_report_templates_enforced_global';

export const REPORT_TEMPLATE_SCOPE_INDEXES = [
  'idx_report_templates_owner_active',
  'uq_report_templates_scope_name',
  'uq_report_templates_scope_default',
  'uq_report_templates_global_enforced',
] as const;

export const REPORT_TEMPLATE_SCOPE_MIGRATION_SQL: readonly string[] = [
  `ALTER TABLE report_templates ADD COLUMN IF NOT EXISTS progress_page text`,
  `ALTER TABLE report_templates ADD COLUMN IF NOT EXISTS owner_user_id integer`,
  `ALTER TABLE report_templates ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false`,
  `ALTER TABLE report_templates ADD COLUMN IF NOT EXISTS is_enforced boolean NOT NULL DEFAULT false`,
  `UPDATE report_templates template
      SET owner_user_id = template.created_by
     WHERE template.owner_user_id IS NULL
       AND template.created_by IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM instructor_profiles profile
          WHERE profile.user_id = template.created_by
       )`,
  `WITH preferred AS (
     SELECT id
       FROM report_templates
      WHERE deleted_at IS NULL AND owner_user_id IS NULL
      ORDER BY CASE WHEN name='정규 수업(기본)' THEN 0 ELSE 1 END, id
      LIMIT 1
   )
   UPDATE report_templates template
      SET is_default = true
     FROM preferred
    WHERE template.id = preferred.id
      AND NOT EXISTS (
        SELECT 1 FROM report_templates existing
         WHERE existing.deleted_at IS NULL
           AND existing.owner_user_id IS NULL
           AND existing.is_default
      )`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_report_templates_owner_user') THEN
       ALTER TABLE report_templates
         ADD CONSTRAINT fk_report_templates_owner_user
         FOREIGN KEY (owner_user_id) REFERENCES instructor_profiles(user_id)
         ON DELETE RESTRICT NOT VALID;
     END IF;
   END $$`,
  `ALTER TABLE report_templates VALIDATE CONSTRAINT fk_report_templates_owner_user`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='${REPORT_TEMPLATE_SCOPE_CONSTRAINT}') THEN
       ALTER TABLE report_templates
         ADD CONSTRAINT ${REPORT_TEMPLATE_SCOPE_CONSTRAINT}
         CHECK (NOT is_enforced OR owner_user_id IS NULL) NOT VALID;
     END IF;
   END $$`,
  `ALTER TABLE report_templates VALIDATE CONSTRAINT ${REPORT_TEMPLATE_SCOPE_CONSTRAINT}`,
  `DROP INDEX IF EXISTS uq_report_templates_active_name`,
  `CREATE INDEX IF NOT EXISTS idx_report_templates_owner_active
     ON report_templates (owner_user_id, id) WHERE deleted_at IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_report_templates_scope_name
     ON report_templates (COALESCE(owner_user_id, 0), name) WHERE deleted_at IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_report_templates_scope_default
     ON report_templates (COALESCE(owner_user_id, 0))
     WHERE deleted_at IS NULL AND is_default`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_report_templates_global_enforced
     ON report_templates (is_enforced)
     WHERE deleted_at IS NULL AND owner_user_id IS NULL AND is_enforced`,
];
