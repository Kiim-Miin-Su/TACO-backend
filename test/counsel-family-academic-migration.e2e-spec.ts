import {
  COUNSEL_FAMILY_ACADEMIC_EXPAND_SQL,
  STUDENT_ACADEMIC_HISTORIES_INDEX_SQL,
  STUDENT_ACADEMIC_HISTORIES_TABLE_SQL,
  STUDENT_FAMILY_RELATIONS_INDEX_SQL,
  STUDENT_FAMILY_RELATIONS_TABLE_SQL,
} from '../src/database/migrations/counsel-family-academic-expand.migration';
import { TBO36_STUDENTS_SQL } from '../src/database/migrations/staff-pay-calendar.migration';

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

  it('versioned expand와 cold-start runtime 모두 students grade를 0..13으로 유지한다', () => {
    expect(COUNSEL_FAMILY_ACADEMIC_EXPAND_SQL.join('\n')).toContain('grade BETWEEN 0 AND 13');
    expect(TBO36_STUDENTS_SQL.join('\n')).toContain('grade BETWEEN 0 AND 13');
    expect(TBO36_STUDENTS_SQL.join('\n')).not.toContain('grade BETWEEN 0 AND 12');
  });

  it('상담 참고 사항을 멱등 expand한다', () => {
    expect(COUNSEL_FAMILY_ACADEMIC_EXPAND_SQL[0]).toBe(
      'ALTER TABLE counsel_forms ADD COLUMN IF NOT EXISTS reference_notes text',
    );
  });
});
