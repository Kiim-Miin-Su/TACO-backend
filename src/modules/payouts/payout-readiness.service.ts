import { BadRequestException, Injectable } from '@nestjs/common';
import type { PayReadiness } from '@kms545487/contracts';
import { InMemoryDatabase } from '../../database/in-memory.database';
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
  ) {}

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

    const timeParts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now);
    const part = (type: 'hour' | 'minute') => timeParts.find((item) => item.type === type)?.value ?? '00';

    return evaluatePayoutReadiness({
      sessions: this.db.findAll<ClassSession>(SESSIONS),
      enrollments: this.db.findAll<Enrollment>(ENROLLMENTS),
      reports: this.db.findAll<SessionReportRow>(SESSION_REPORTS),
      periodStart,
      periodEnd,
      instructorId,
      effectiveRateOf: (courseId) => this.courses.findOptional(courseId)?.hourlyRate,
      nowDate: today,
      nowTime: `${part('hour')}:${part('minute')}`,
    });
  }
}
