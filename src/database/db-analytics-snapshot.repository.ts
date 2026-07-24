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
  COURSES_SPEC, ENROLLMENTS_SPEC, EXPENSES_SPEC, INSTRUCTOR_PAYOUTS_SPEC, PAYMENTS_SPEC, STUDENTS_SPEC,
  STUDENT_INTERESTS_SPEC, SUBJECTS_SPEC,
} from './calendar-asset-specs';
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
}
