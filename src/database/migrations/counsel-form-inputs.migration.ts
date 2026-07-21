export const COUNSEL_FORM_INPUTS_MIGRATION_ID = '20260721_01_tbo34_counsel_form_inputs';

/**
 * 작성 주체는 source와 의미가 다르다. source는 유입 채널이고 submitter_type은 폼을 입력한 사람이다.
 * 기존 행은 근거 없이 학부모/학생으로 추정하지 않고 unknown으로 보존한다.
 */
export const COUNSEL_FORM_INPUTS_MIGRATION_SQL: readonly string[] = [
  `ALTER TABLE counsel_forms
     ADD COLUMN IF NOT EXISTS submitter_type varchar(16) NOT NULL DEFAULT 'unknown'
     CHECK (submitter_type IN ('parent','student','staff','unknown'))`,
];
