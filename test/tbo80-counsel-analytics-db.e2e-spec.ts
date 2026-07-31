// [TBO-80 80F] counsel 분석 DB 푸시다운 경로 ↔ 순수 함수 SSOT 패리티 (PG 전용).
//
//  hermetic e2e(counsel-analytics.e2e-spec)는 메모리 폴백 경로만 지나므로, 이 스펙이
//  **PostgreSQL 경로**(기간 창 WHERE·ANY 조인 선별·컬럼 별칭 매핑)를 실 DB에서 실증한다.
//  판정: 서비스 API 결과 === computeCounselFunnel/Correlation(같은 시드 데이터) — 순수 함수가
//  집계 SSOT이므로 이 대조가 곧 "응답 모양·수치 불변"의 증거다. 기간 경계(포함/제외)도
//  경계일 픽스처로 고정한다(SQL 창은 ±1일 여유·정확 판정은 함수 — 제외 누락이 구조적으로 불가능함을
//  실측으로도 재확인).
//  실행: RUN_DB_CRUD_E2E=1 DATABASE_URL=postgres://... (로컬 fresh DB 권장 — 운영 금지)
import { INestApplication } from '@nestjs/common';
import { createTestApp } from './setup-app';
import { PostgresConnectionService } from '../src/database/postgres-connection.service';
import { CounselService } from '../src/modules/counsel/counsel.service';
import {
  computeCounselCorrelation, computeCounselFunnel, type CounselAnalyticsSnapshot,
} from '../src/modules/counsel/counsel-analytics';

const enabled = process.env.RUN_DB_CRUD_E2E === '1';
const describeDb = enabled ? describe : describe.skip;

// 시드 오프셋 — 로컬 bootstrap 시드와 id 충돌 방지(읽기 경로 검증 전용 합성 행).
const OFF = 908000;

// counsel-analytics.e2e-spec의 결정적 스냅샷 + 기간 경계 픽스처 2건(7/31 포함 · 8/1 제외).
const seed = (): CounselAnalyticsSnapshot => ({
  forms: [
    { id: OFF + 1, studentId: OFF + 1, status: 'requested', createdAt: '2026-07-01T00:00:00.000Z' },
    { id: OFF + 2, studentId: OFF + 2, status: 'pending', createdAt: '2026-07-02T00:00:00.000Z' },
    { id: OFF + 3, studentId: OFF + 3, status: 'registered', createdAt: '2026-07-03T00:00:00.000Z' },
    { id: OFF + 4, studentId: OFF + 4, status: 'dropped', createdAt: '2026-07-04T00:00:00.000Z' },
    { id: OFF + 5, studentId: OFF + 5, status: 'requested', createdAt: '2026-06-01T00:00:00.000Z' }, // 기간 밖(이전)
    { id: OFF + 6, studentId: OFF + 6, status: 'requested', createdAt: '2026-07-31T23:59:59.000Z' }, // 경계 포함
    { id: OFF + 7, studentId: OFF + 7, status: 'requested', createdAt: '2026-08-01T00:00:00.000Z' }, // 경계 제외
  ],
  rounds: [
    { counselFormId: OFF + 2, roundNo: 0, result: 'positive', completedAt: '2026-07-05T00:00:00.000Z' },
    { counselFormId: OFF + 3, roundNo: 0, result: 'neutral', completedAt: '2026-07-06T00:00:00.000Z' },
    { counselFormId: OFF + 3, roundNo: 1, result: 'registered', completedAt: '2026-07-13T00:00:00.000Z' },
    { counselFormId: OFF + 4, roundNo: 0, result: 'negative', completedAt: '2026-07-07T00:00:00.000Z' },
  ],
  interests: [
    { studentId: OFF + 1, courseId: OFF + 10, customLabel: null },
    { studentId: OFF + 3, courseId: OFF + 10, customLabel: null },
    { studentId: OFF + 3, courseId: OFF + 12, customLabel: null },
    { studentId: OFF + 4, courseId: null, customLabel: '미술 입시' },
  ],
  enrollments: [
    { studentId: OFF + 3, courseId: OFF + 11, status: 'active' },
    { studentId: OFF + 3, courseId: OFF + 12, status: 'canceled' },
    { studentId: OFF + 1, courseId: OFF + 10, status: 'active' },
  ],
  courses: [
    { id: OFF + 10, subjectId: OFF + 1 }, { id: OFF + 11, subjectId: OFF + 2 }, { id: OFF + 12, subjectId: OFF + 1 },
  ],
  subjects: [{ id: OFF + 1, name: `TBO80영어_${OFF}` }, { id: OFF + 2, name: `TBO80수학_${OFF}` }],
});

const JULY = { from: '2026-07-01', to: '2026-07-31' };

describeDb('[TBO-80 80F] counsel analytics DB 푸시다운 패리티 (PG e2e)', () => {
  let app: INestApplication;
  let pg: PostgresConnectionService;
  let service: CounselService;
  const data = seed();

  const cleanup = async () => {
    // 합성 행 전량 물리 삭제 — OFF 대역 전용(읽기 경로 검증용 행이라 업무 이력이 아니다).
    await pg.query(`DELETE FROM counsel_rounds WHERE counsel_form_id >= $1`, [OFF]);
    await pg.query(`DELETE FROM counsel_forms WHERE id >= $1`, [OFF]);
    await pg.query(`DELETE FROM student_interests WHERE student_id >= $1`, [OFF]);
    await pg.query(`DELETE FROM enrollments WHERE student_id >= $1`, [OFF]);
    await pg.query(`DELETE FROM courses WHERE id >= $1`, [OFF]);
    await pg.query(`DELETE FROM subjects WHERE id >= $1`, [OFF]);
    await pg.query(`DELETE FROM students WHERE id >= $1`, [OFF]);
  };

  beforeAll(async () => {
    if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
      throw new Error('RUN_DB_CRUD_E2E=1은 DATABASE_URL이 필요합니다(로컬 fresh DB 권장).');
    }
    process.env.TEST_BUSINESS_FIXTURES = '0';
    app = await createTestApp();
    pg = app.get(PostgresConnectionService);
    service = app.get(CounselService);
    if (!pg.ready) throw new Error('이 스펙은 PostgreSQL 경로 검증이 목적이다 — pg.ready=false면 무의미');
    await cleanup();

    // FK 사슬 순서: subjects → courses → students → forms/interests/enrollments → rounds.
    for (const subject of data.subjects) {
      await pg.query(
        `INSERT INTO subjects (id, name, code, created_at, updated_at) VALUES ($1, $2, $3, now(), now())`,
        [subject.id, subject.name, `T80_${subject.id}`],
      );
    }
    for (const course of data.courses) {
      await pg.query(
        `INSERT INTO courses (id, name, subject_id, created_at, updated_at) VALUES ($1, $2, $3, now(), now())`,
        [course.id, `TBO80코스_${course.id}`, course.subjectId],
      );
    }
    const studentIds = [...new Set(data.forms.map((form) => form.studentId))];
    for (const studentId of studentIds) {
      await pg.query(
        `INSERT INTO students (id, name, birth_date, residence_type, language_type, level_status, status, created_at, updated_at)
         VALUES ($1, $2, '2010-01-01', 'domestic', 'ko', 'none', 'active', now(), now())`,
        [studentId, `TBO80학생_${studentId}`],
      );
    }
    for (const form of data.forms) {
      await pg.query(
        `INSERT INTO counsel_forms (id, student_id, status, source, submitter_type, created_at, updated_at)
         VALUES ($1, $2, $3, 'manual', 'staff', $4::timestamptz, now())`,
        [form.id, form.studentId, form.status, form.createdAt],
      );
    }
    for (const round of data.rounds) {
      await pg.query(
        `INSERT INTO counsel_rounds (counsel_form_id, round_no, result, completed_at, is_completed, form_snapshot, created_at, updated_at)
         VALUES ($1, $2, $3, $4::timestamptz, true, '{}'::jsonb, now(), now())`,
        [round.counselFormId, round.roundNo, round.result, round.completedAt],
      );
    }
    const priorityByStudent = new Map<number, number>(); // uq(student_id, priority) 대응
    for (const interest of data.interests) {
      const priority = (priorityByStudent.get(interest.studentId) ?? 0) + 1;
      priorityByStudent.set(interest.studentId, priority);
      await pg.query(
        `INSERT INTO student_interests (student_id, course_id, custom_label, priority, created_at, updated_at)
         VALUES ($1, $2, $3, $4, now(), now())`,
        [interest.studentId, interest.courseId, interest.customLabel, priority],
      );
    }
    for (const enrollment of data.enrollments) {
      await pg.query(
        `INSERT INTO enrollments (student_id, course_id, status, completed_sessions, enrolled_at, created_at, updated_at)
         VALUES ($1, $2, $3, 0, '2026-07-01', now(), now())`,
        [enrollment.studentId, enrollment.courseId, enrollment.status],
      );
    }
  }, 60_000);

  afterAll(async () => {
    if (pg?.ready) await cleanup();
    await app?.close();
  });

  // 서비스(SQL 푸시다운) 결과와 순수 함수(SSOT) 결과를 시드 전체 스냅샷으로 대조한다.
  //  단, DB에는 이 스펙 밖의 행(bootstrap 계정 등)이 있을 수 있어 카탈로그(courses/subjects)는
  //  상위집합이다 — 퍼널은 카탈로그 무관, 상관관계는 OFF 대역 course/subject만 조인되므로 무영향.
  it('funnel(7월) — SQL 경로가 순수 함수 기대와 정확히 일치(경계 7/31 포함·8/1 제외)', async () => {
    const expected = computeCounselFunnel(data, JULY);
    expect(expected.total).toBe(5); // 4 + 경계 포함 1 — 픽스처 자기 검증
    const actual = await service.funnel(JULY);
    expect(actual).toEqual(expected);
  });

  it('funnel(무기간) — 전체 7건이 SQL 경로에서도 동일 집계', async () => {
    const expected = computeCounselFunnel(data, {});
    expect(expected.total).toBe(7);
    const actual = await service.funnel({});
    expect(actual).toEqual(expected);
  });

  it('correlation(7월) — 조인 선별(해당 학생 관심·수강만)이 순수 함수 기대와 일치', async () => {
    const expected = computeCounselCorrelation(data, JULY);
    const actual = await service.correlation(JULY);
    expect(actual).toEqual(expected);
  });
});
