import { BadRequestException, Injectable } from '@nestjs/common';
import { Attendance, ATTENDANCE } from '../attendance/attendance.entity'; // [기간설정 ①]
import type { PayReadiness } from '@kms545487/contracts';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { ClassSessionsStore } from '../../modules/schedule/class-sessions.store';
import { ATTENDANCE_SPEC, COURSES_SPEC, ENROLLMENTS_SPEC, SESSION_REPORTS_SPEC } from '../../database/calendar-asset-specs';
import { addDaysISO } from '../../common/time.util';
import { dateInTimeZone } from '../students/student-grade.policy';
import { CoursesService } from '../courses/courses.service';
import { ENROLLMENTS, type Enrollment } from '../enrollments/enrollment.entity';
import { SESSION_REPORTS, type SessionReportRow } from '../reports/report.entity';
import { SESSIONS, type ClassSession } from '../schedule/schedule.entity';
import { evaluatePayoutReadiness } from './payout-readiness.policy';

@Injectable()
export class PayoutReadinessService {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly courses: CoursesService,
    private readonly store: PostgresCollectionStore,
    private readonly sessionsStore: ClassSessionsStore,
  ) {}

  /** [TBO-56 C2b] 준비 상태 READ도 요청마다 입력 표 재수화 — 교차 인스턴스 변경 즉시 반영. */
  async evaluateFresh(instructorId?: number, from?: string, to?: string, now = new Date()): Promise<PayReadiness> {
    await this.sessionsStore.ensureReady();
    await this.store.hydrate(ENROLLMENTS_SPEC);
    await this.store.hydrate(SESSION_REPORTS_SPEC);
    await this.store.hydrate(COURSES_SPEC);
    await this.store.hydrate(ATTENDANCE_SPEC); // [TBO-66 R1] 출결도 적격 입력(기간설정 ①) — 미재수화면 교차 인스턴스 오판정
    return this.evaluate(instructorId, from, to, now);
  }

  evaluate(instructorId?: number, from?: string, to?: string, now = new Date()): PayReadiness {
    for (const [name, value] of [['from', from], ['to', to]] as const) {
      const parsed = value == null ? null : new Date(`${value}T00:00:00.000Z`);
      if (value != null && (!/^\d{4}-\d{2}-\d{2}$/.test(value)
        || Number.isNaN(parsed!.getTime())
        || parsed!.toISOString().slice(0, 10) !== value)) {
        throw new BadRequestException(`${name}은 YYYY-MM-DD 형식이어야 합니다.`);
      }
    }
    const today = dateInTimeZone(now);
    const periodEnd = to || today;
    const periodStart = from || addDaysISO(periodEnd, -90);
    if (periodStart > periodEnd) throw new BadRequestException('정산 기간이 잘못되었습니다(from > to)');


    return evaluatePayoutReadiness({
      sessions: this.db.findAll<ClassSession>(SESSIONS),
      enrollments: this.db.findAll<Enrollment>(ENROLLMENTS),
      reports: this.db.findAll<SessionReportRow>(SESSION_REPORTS),
      attendance: this.db.findAll<Attendance>(ATTENDANCE), // [기간설정 ①]
      periodStart,
      periodEnd,
      instructorId,
      effectiveRateOf: (courseId) => this.courses.findOptional(courseId)?.hourlyRate,
      nowMs: now.getTime(), // [TBO-65 M1] 시각 술어는 epoch 하나로
    });
  }
}
