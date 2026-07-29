export const SCHEMA_SHAPE_INTEGRITY_MIGRATION_ID =
  '20260730_06_tbo78_schema_shape_integrity';

type CheckSpec = {
  table: string;
  name: string;
  column: string;
  expression: string;
};

type ForeignKeySpec = {
  table: string;
  name: string;
  column: string;
  target: string;
  onDelete: 'CASCADE' | 'SET NULL';
};

export const SCHEMA_SHAPE_CHECKS: readonly CheckSpec[] = [
  { table: 'auth_events', name: 'c_auth_events_event_type_domain', column: 'event_type', expression: "event_type IN ('login_success','login_failure','logout','recover_id_requested','recover_id_completed','password_reset_requested','password_reset_completed','refresh_reuse_blocked','csrf_origin_blocked')" },
  { table: 'students', name: 'c_students_school_type_domain', column: 'school_type', expression: "school_type IS NULL OR school_type IN ('international','foreign','homeschool','local','etc')" },
  { table: 'students', name: 'c_students_residence_type_domain', column: 'residence_type', expression: "residence_type IN ('domestic','overseas')" },
  { table: 'students', name: 'c_students_language_type_domain', column: 'language_type', expression: "language_type IN ('korean','english','bilingual','etc')" },
  { table: 'students', name: 'c_students_level_status_domain', column: 'level_status', expression: "level_status IN ('advanced_years','on_grade','below_years','unknown')" },
  { table: 'courses', name: 'c_courses_status_domain', column: 'status', expression: "status IN ('active','not_active','archived')" },
  { table: 'counsel_rounds', name: 'c_counsel_rounds_result_domain', column: 'result', expression: "result IS NULL OR result IN ('positive','neutral','negative','no_response','registered')" },
  { table: 'audit_log', name: 'c_audit_log_action_domain', column: 'action', expression: "action IN ('create','update','delete','approve','reject','status_change')" },
  { table: 'payments', name: 'c_payments_method_domain', column: 'payment_method', expression: "payment_method IS NULL OR payment_method IN ('card','transfer','cash','point','etc')" },
  { table: 'availability_blocks', name: 'c_availability_owner_type_domain', column: 'owner_type', expression: "owner_type IN ('student','instructor','room')" },
  { table: 'availability_blocks', name: 'c_availability_kind_domain', column: 'kind', expression: "kind IN ('available','unavailable','online_only')" },
  { table: 'expenses', name: 'c_expenses_category_domain', column: 'category', expression: "category IN ('supplies','equipment','books','rent','utility','marketing','meal','etc')" },
  { table: 'expenses', name: 'c_expenses_status_domain', column: 'status', expression: "status IN ('requested','approved','rejected')" },
  { table: 'expenses', name: 'c_expenses_method_domain', column: 'payment_method', expression: "payment_method IS NULL OR payment_method IN ('card','transfer','cash','point','etc')" },
  { table: 'transactions', name: 'c_transactions_direction_domain', column: 'direction', expression: "direction IN ('in','out')" },
  { table: 'transactions', name: 'c_transactions_category_domain', column: 'category', expression: "category IN ('enrollment','re_enrollment','refund','instructor_payout','payout_reversal','expense','etc')" },
  { table: 'transactions', name: 'c_transactions_method_domain', column: 'method', expression: "method IS NULL OR method IN ('card','transfer','cash','point','etc')" },
  { table: 'academy_events', name: 'c_academy_events_type_domain', column: 'type', expression: "type IN ('notice','exam','holiday','closure','event')" },
] as const;

export const SCHEMA_SHAPE_FOREIGN_KEYS: readonly ForeignKeySpec[] = [
  { table: 'nav_seen_states', name: 'fk_nav_seen_states_user', column: 'user_id', target: 'users(id)', onDelete: 'CASCADE' },
  { table: 'students', name: 'fk_students_user', column: 'user_id', target: 'users(id)', onDelete: 'SET NULL' },
  { table: 'courses', name: 'fk_courses_instructor', column: 'instructor_id', target: 'users(id)', onDelete: 'SET NULL' },
  { table: 'courses', name: 'fk_courses_subject', column: 'subject_id', target: 'subjects(id)', onDelete: 'SET NULL' },
  { table: 'calendar_view_presets', name: 'fk_calendar_view_presets_creator', column: 'created_by', target: 'users(id)', onDelete: 'SET NULL' },
  { table: 'class_session_series', name: 'fk_class_session_series_creator', column: 'created_by', target: 'users(id)', onDelete: 'SET NULL' },
  { table: 'class_session_series', name: 'fk_class_session_series_updater', column: 'updated_by', target: 'users(id)', onDelete: 'SET NULL' },
  { table: 'expenses', name: 'fk_expenses_paid_by', column: 'paid_by', target: 'users(id)', onDelete: 'SET NULL' },
  { table: 'rooms', name: 'fk_rooms_building', column: 'building_id', target: 'rooms(id)', onDelete: 'SET NULL' },
] as const;

const addCheck = ({ table, name, expression }: CheckSpec): string => `
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.${table}'::regclass AND conname='${name}') THEN
      ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${expression}) NOT VALID;
    END IF;
  END $$`;

const validateCheck = ({ table, name }: CheckSpec): string =>
  `ALTER TABLE ${table} VALIDATE CONSTRAINT ${name}`;

const addForeignKey = ({ table, name, column, target, onDelete }: ForeignKeySpec): string => `
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.${table}'::regclass AND conname='${name}') THEN
      ALTER TABLE ${table}
        ADD CONSTRAINT ${name} FOREIGN KEY (${column}) REFERENCES ${target}
        ON DELETE ${onDelete} NOT VALID;
    END IF;
  END $$`;

const validateForeignKey = ({ table, name }: ForeignKeySpec): string =>
  `ALTER TABLE ${table} VALIDATE CONSTRAINT ${name}`;

export const SCHEMA_SHAPE_INTEGRITY_SQL = [
  ...SCHEMA_SHAPE_CHECKS.map(addCheck),
  ...SCHEMA_SHAPE_FOREIGN_KEYS.map(addForeignKey),
  `ALTER TABLE academy_events ALTER COLUMN type SET DEFAULT 'notice'`,
  ...SCHEMA_SHAPE_CHECKS.map(validateCheck),
  ...SCHEMA_SHAPE_FOREIGN_KEYS.map(validateForeignKey),
] as const;
