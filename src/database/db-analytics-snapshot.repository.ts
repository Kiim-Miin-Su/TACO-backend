// [TBO-54 C2 2026-07-23] 분석 스냅샷의 **단일 DB 저장소** — TBO-50 P0-4 이행.
//  GraphQL revenue 게이트웨이와 REST counsel 분석이 이 저장소 하나를 소비한다(프로세스 메모리
//  projection 금지). 한 uow tx + REPEATABLE READ로 다표 조회가 **같은 DB snapshot**을 본다
//  (READ COMMITTED는 문장마다 스냅샷이 갈려 표 간 시점 불일치 가능 — 재무 집계에서 금지).
//  메모리 모드(PG 미가용)에서는 findActive가 메모리로 폴백 — 계약 동일.
import { Injectable, Logger } from '@nestjs/common';
import { PostgresConnectionService } from './postgres-connection.service';
import { PostgresCollectionStore } from './postgres-collection.store';
import { CalendarUnitOfWork } from './calendar-unit-of-work.service';
import {
  COUNSEL_FORMS_SPEC, COUNSEL_ROUNDS_SPEC,
  COURSES_SPEC, ENROLLMENTS_SPEC, EXPENSES_SPEC, INSTRUCTOR_PAYOUTS_SPEC, PAYMENTS_SPEC, STUDENTS_SPEC,
  STUDENT_INTERESTS_SPEC, SUBJECTS_SPEC,
} from './calendar-asset-specs';
import { normalizeQueryRows, toIsoString } from './postgres-row.util';
import type { CounselAnalyticsRange } from '@kms545487/contracts';
import type { CounselAnalyticsSnapshot } from '../modules/counsel/counsel-analytics';
import type { CounselForm, CounselRound } from '../modules/counsel/counsel.entity';
import type { RevenueSnapshot } from '../modules/graphql/revenue-analytics';
import type { Payment } from '../modules/payments/payment.entity';
import type { Enrollment } from '../modules/enrollments/enrollment.entity';
import type { Course } from '../modules/courses/course.entity';
import type { Subject } from '../modules/subjects/subject.entity';
import type { Student } from '../modules/students/student.entity';
import type { StudentInterest } from '../modules/students/student-interest.entity';
import type { Expense } from '../modules/expenses/expense.entity';

type PayoutLike = { amount: number; status: string; paidAt?: string | null };

/** counsel 상관관계가 소비하는 조인 표 4종(희망 SSOT×등록 SSOT×카탈로그). */
export type CounselJoinTables = {
  interests: StudentInterest[];
  enrollments: Enrollment[];
  courses: Course[];
  subjects: Subject[];
};

@Injectable()
export class DbAnalyticsSnapshotRepository {
  private readonly logger = new Logger('analytics');

  constructor(
    private readonly store: PostgresCollectionStore,
    private readonly postgres: PostgresConnectionService,
    private readonly uow: CalendarUnitOfWork,
  ) {}

  /** 한 tx 한 snapshot으로 읽기 — 이미 tx 안이면(중첩) 그대로 진행, 밖이면 REPEATABLE READ tx를 연다. */
  private async inSnapshot<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.postgres.ready || this.postgres.inTransaction) return fn();
    return this.uow.run(async () => {
      await this.postgres.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      return fn();
    });
  }

  /** GraphQL revenueReport/financeSummary 원천 7표 — 같은 snapshot 보장. */
  async revenue(): Promise<RevenueSnapshot> {
    const startedAt = Date.now();
    const snapshot = await this.inSnapshot(async () => ({
      payments: (await this.store.findActive<Payment>(PAYMENTS_SPEC)) as unknown as RevenueSnapshot['payments'],
      enrollments: (await this.store.findActive<Enrollment>(ENROLLMENTS_SPEC)) as unknown as RevenueSnapshot['enrollments'],
      courses: (await this.store.findActive<Course>(COURSES_SPEC)) as unknown as RevenueSnapshot['courses'],
      subjects: (await this.store.findActive<Subject>(SUBJECTS_SPEC)) as unknown as RevenueSnapshot['subjects'],
      students: (await this.store.findActive<Student>(STUDENTS_SPEC)) as unknown as RevenueSnapshot['students'],
      expenses: (await this.store.findActive<Expense>(EXPENSES_SPEC)) as unknown as RevenueSnapshot['expenses'],
      payouts: (await this.store.findActive<PayoutLike & { id: number; createdAt: string; updatedAt: string }>(INSTRUCTOR_PAYOUTS_SPEC)) as unknown as RevenueSnapshot['payouts'],
    }));
    // [대표 지시 콘솔 로깅] 집계 원천 크기만(내용·PII 0) — 스냅샷 이상(빈 표 등) 관측용.
    this.logger.log(`snapshot=revenue rows=${snapshot.payments.length}/${snapshot.enrollments.length}/${snapshot.courses.length}/${snapshot.subjects.length}/${snapshot.students.length}/${snapshot.expenses.length}/${snapshot.payouts.length} ms=${Date.now() - startedAt}`);
    return snapshot;
  }

  /** counsel 분석 조인 표 4종 — forms/rounds는 counsel.service가 같은 tx 규약으로 읽는다. */
  async counselJoins(): Promise<CounselJoinTables> {
    const startedAt = Date.now();
    const tables = await this.inSnapshot(async () => ({
      interests: await this.store.findActive<StudentInterest>(STUDENT_INTERESTS_SPEC),
      enrollments: await this.store.findActive<Enrollment>(ENROLLMENTS_SPEC),
      courses: await this.store.findActive<Course>(COURSES_SPEC),
      subjects: await this.store.findActive<Subject>(SUBJECTS_SPEC),
    }));
    this.logger.log(`snapshot=counsel rows=${tables.interests.length}/${tables.enrollments.length}/${tables.courses.length}/${tables.subjects.length} ms=${Date.now() - startedAt}`);
    return tables;
  }

  /** [TBO-80 80F] counsel 퍼널·상관관계 스냅샷 — 행 선별을 DB로 내린다(TBO-30D "DB 집계" 요구의 이행).
   *
   *  설계 결정: **집계 로직은 SQL로 옮기지 않는다.** `counsel-analytics.ts` 순수 함수가 집계의
   *  단일 진실원이고(파일 헤더 규약 — API·e2e가 같은 함수 소비), SQL GROUP BY 재구현은 그 사본을
   *  만든다(FC-1·OtpChallengeResult 보류와 같은 부류의 거짓 단일화). 대신:
   *   · 기간 필터·조인 선별(해당 폼의 회차·해당 학생의 관심/수강만)을 SQL WHERE로 푸시다운
   *   · 컬럼은 스냅샷 타입이 요구하는 최소만 SELECT
   *   · SQL 기간 창은 **여유 ±1일**로 잡고 정확한 경계 판정은 종전처럼 순수 함수(inRange)가 수행
   *     → SQL 술어가 함수 술어의 상위집합임이 구조적으로 보장돼, 경계 시맨틱(dayOf=ISO 슬라이스)이
   *       DB 타임존 변환과 어긋나도 결과가 달라질 수 없다(제외 누락 불가능).
   *  PG 미가용(hermetic e2e)이면 종전과 동일한 전체 활성 로드로 폴백 — 계약 동일. */
  async counselAnalytics(range: CounselAnalyticsRange = {}): Promise<CounselAnalyticsSnapshot> {
    const startedAt = Date.now();
    const snapshot = await this.inSnapshot(async (): Promise<CounselAnalyticsSnapshot> => {
      if (!this.postgres.ready) return this.counselAnalyticsFromStore();

      const params: unknown[] = [];
      const bounds: string[] = ['deleted_at IS NULL'];
      const DAY_MS = 86_400_000;
      if (range.from) {
        params.push(new Date(Date.parse(`${range.from}T00:00:00Z`) - DAY_MS).toISOString());
        bounds.push(`created_at >= $${params.length}::timestamptz`);
      }
      if (range.to) {
        params.push(new Date(Date.parse(`${range.to}T00:00:00Z`) + 2 * DAY_MS).toISOString());
        bounds.push(`created_at < $${params.length}::timestamptz`);
      }
      const formRows = normalizeQueryRows(await this.postgres.query(
        `SELECT id, student_id AS "studentId", status, created_at AS "createdAt"
           FROM counsel_forms WHERE ${bounds.join(' AND ')}`,
        params,
      ));
      const forms = formRows.map((row) => ({
        id: Number(row.id),
        studentId: Number(row.studentId),
        status: row.status as CounselAnalyticsSnapshot['forms'][number]['status'],
        createdAt: toIsoString(row.createdAt) ?? String(row.createdAt),
      }));
      const formIds = forms.map((form) => form.id);
      const studentIds = [...new Set(forms.map((form) => form.studentId))];

      const rounds = formIds.length
        ? normalizeQueryRows(await this.postgres.query(
            `SELECT counsel_form_id AS "counselFormId", round_no AS "roundNo", result, completed_at AS "completedAt"
               FROM counsel_rounds WHERE deleted_at IS NULL AND counsel_form_id = ANY($1::int[])`,
            [formIds],
          )).map((row) => ({
            counselFormId: Number(row.counselFormId),
            roundNo: Number(row.roundNo),
            result: (row.result ?? null) as CounselAnalyticsSnapshot['rounds'][number]['result'],
            completedAt: row.completedAt == null ? null : (toIsoString(row.completedAt) ?? String(row.completedAt)),
          }))
        : [];
      const interests = studentIds.length
        ? normalizeQueryRows(await this.postgres.query(
            `SELECT student_id AS "studentId", course_id AS "courseId", custom_label AS "customLabel"
               FROM student_interests WHERE deleted_at IS NULL AND student_id = ANY($1::int[])`,
            [studentIds],
          )).map((row) => ({
            studentId: Number(row.studentId),
            courseId: row.courseId == null ? null : Number(row.courseId),
            customLabel: (row.customLabel ?? null) as string | null,
          }))
        : [];
      const enrollments = studentIds.length
        ? normalizeQueryRows(await this.postgres.query(
            `SELECT student_id AS "studentId", course_id AS "courseId", status
               FROM enrollments WHERE deleted_at IS NULL AND student_id = ANY($1::int[])`,
            [studentIds],
          )).map((row) => ({
            studentId: Number(row.studentId),
            courseId: Number(row.courseId),
            status: String(row.status),
          }))
        : [];
      const courses = normalizeQueryRows(await this.postgres.query(
        `SELECT id, subject_id AS "subjectId" FROM courses WHERE deleted_at IS NULL`,
      )).map((row) => ({ id: Number(row.id), subjectId: Number(row.subjectId) }));
      const subjects = normalizeQueryRows(await this.postgres.query(
        `SELECT id, name FROM subjects WHERE deleted_at IS NULL`,
      )).map((row) => ({ id: Number(row.id), name: String(row.name) }));

      return { forms, rounds, interests, enrollments, courses, subjects };
    });
    this.logger.log(`snapshot=counsel-analytics rows=${snapshot.forms.length}/${snapshot.rounds.length}/${snapshot.interests.length}/${snapshot.enrollments.length}/${snapshot.courses.length}/${snapshot.subjects.length} ms=${Date.now() - startedAt}`);
    return snapshot;
  }

  /** 메모리 폴백 — 종전 counsel.service 조립 경로와 동일한 전체 활성 로드(계약 동일·순수 함수가 필터). */
  private async counselAnalyticsFromStore(): Promise<CounselAnalyticsSnapshot> {
    const [forms, rounds, joins] = await Promise.all([
      this.store.findActive<CounselForm>(COUNSEL_FORMS_SPEC),
      this.store.findActive<CounselRound>(COUNSEL_ROUNDS_SPEC),
      this.counselJoins(),
    ]);
    return {
      forms: forms.map((form) => ({ id: form.id, studentId: form.studentId, status: form.status, createdAt: form.createdAt })),
      rounds: rounds.map((round) => ({
        counselFormId: round.counselFormId, roundNo: round.roundNo,
        result: round.result ?? null, completedAt: round.completedAt ?? null,
      })),
      interests: joins.interests.map((interest) => ({
        studentId: interest.studentId, courseId: interest.courseId ?? null, customLabel: interest.customLabel ?? null,
      })),
      enrollments: joins.enrollments.map((enrollment) => ({
        studentId: enrollment.studentId, courseId: enrollment.courseId, status: enrollment.status,
      })),
      courses: joins.courses.map((course) => ({ id: course.id, subjectId: course.subjectId })),
      subjects: joins.subjects.map((subject) => ({ id: subject.id, name: subject.name })),
    };
  }
}
