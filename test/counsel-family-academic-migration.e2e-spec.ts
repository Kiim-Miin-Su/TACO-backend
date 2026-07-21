import {
  COUNSEL_FAMILY_ACADEMIC_EXPAND_SQL,
  STUDENT_ACADEMIC_HISTORIES_INDEX_SQL,
  STUDENT_ACADEMIC_HISTORIES_TABLE_SQL,
  STUDENT_FAMILY_RELATIONS_INDEX_SQL,
  STUDENT_FAMILY_RELATIONS_TABLE_SQL,
} from '../src/database/migrations/counsel-family-academic-expand.migration';
import { TBO36_STUDENTS_SQL } from '../src/database/migrations/staff-pay-calendar.migration';
import {
  COUNSEL_FORMS_CANONICAL_TABLE_SQL,
  COUNSEL_STUDENT_SSOT_CONTRACT_SQL,
  STUDENTS_CANONICAL_TABLE_SQL,
} from '../src/database/migrations/counsel-student-ssot-contract.migration';
import { COUNSEL_ROUND_SNAPSHOTS_RUNTIME_SQL } from '../src/database/migrations/counsel-round-snapshots.migration';

describe('TBO-38 38A counsel/family/academic migration contract', () => {
  it('가족 관계는 양쪽 학생 FK, canonical pair, 관계값과 label을 DB에서 방어한다', () => {
    expect(STUDENT_FAMILY_RELATIONS_TABLE_SQL).toContain('student_id_a integer NOT NULL REFERENCES students(id)');
    expect(STUDENT_FAMILY_RELATIONS_TABLE_SQL).toContain('student_id_b integer NOT NULL REFERENCES students(id)');
    expect(STUDENT_FAMILY_RELATIONS_TABLE_SQL).toContain('student_id_a < student_id_b');
    expect(STUDENT_FAMILY_RELATIONS_TABLE_SQL).toContain("relation_type IN ('sibling','other')");
    expect(STUDENT_FAMILY_RELATIONS_TABLE_SQL).toContain("relation_type = 'other'");
    expect(STUDENT_FAMILY_RELATIONS_INDEX_SQL.join('\n')).toContain('WHERE deleted_at IS NULL');
    expect(STUDENT_FAMILY_RELATIONS_INDEX_SQL.join('\n')).toContain('UNIQUE INDEX');
  });

  it('학교/학년 이력은 G13, 기간, actor FK와 양방향 기간 index를 고정한다', () => {
    expect(STUDENT_ACADEMIC_HISTORIES_TABLE_SQL).toContain('grade BETWEEN 0 AND 13');
    expect(STUDENT_ACADEMIC_HISTORIES_TABLE_SQL).toContain('started_on <= ended_on');
    expect(STUDENT_ACADEMIC_HISTORIES_TABLE_SQL).toContain('changed_by integer NOT NULL REFERENCES users(id)');
    expect(STUDENT_ACADEMIC_HISTORIES_INDEX_SQL).toHaveLength(2);
    expect(STUDENT_ACADEMIC_HISTORIES_INDEX_SQL.every((sql) => sql.includes('WHERE deleted_at IS NULL'))).toBe(true);
  });

  it('과거 expand migration은 legacy grade 범위를 0..13으로 유지한다', () => {
    expect(COUNSEL_FAMILY_ACADEMIC_EXPAND_SQL.join('\n')).toContain('grade BETWEEN 0 AND 13');
    expect(TBO36_STUDENTS_SQL.join('\n')).toContain('grade BETWEEN 0 AND 13');
    expect(TBO36_STUDENTS_SQL.join('\n')).not.toContain('grade BETWEEN 0 AND 12');
  });

  it('38D-B canonical schema는 상담 학생 FK와 academic timeline만 권위로 남긴다', () => {
    expect(COUNSEL_FORMS_CANONICAL_TABLE_SQL).toContain('student_id integer NOT NULL');
    expect(COUNSEL_FORMS_CANONICAL_TABLE_SQL).not.toContain('applicant_name');
    expect(COUNSEL_FORMS_CANONICAL_TABLE_SQL).not.toContain('interest_subject_id');
    expect(STUDENTS_CANONICAL_TABLE_SQL).not.toContain('grade integer');
    expect(STUDENTS_CANONICAL_TABLE_SQL).not.toContain('school_name');
    expect(COUNSEL_STUDENT_SSOT_CONTRACT_SQL.join('\n')).toContain('DROP COLUMN IF EXISTS applicant_name');
    expect(COUNSEL_STUDENT_SSOT_CONTRACT_SQL.join('\n')).toContain('DROP COLUMN IF EXISTS grade');
    expect(COUNSEL_ROUND_SNAPSHOTS_RUNTIME_SQL.join('\n')).not.toContain('applicant_name');
  });

  it('상담 참고 사항을 멱등 expand한다', () => {
    expect(COUNSEL_FAMILY_ACADEMIC_EXPAND_SQL[0]).toBe(
      'ALTER TABLE counsel_forms ADD COLUMN IF NOT EXISTS reference_notes text',
    );
  });
});
