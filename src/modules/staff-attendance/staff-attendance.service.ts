import { TimedModuleInit } from '../../common/performance-timing';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import type {
  InstructorAttendanceLedger,
  InstructorAttendanceLedgerEntry,
  InstructorAttendanceLedgerQuery,
  InstructorAttendanceLedgerSummary,
  StaffAttendanceQuery,
  StaffAttendanceStatus,
  UpsertStaffAttendanceInput,
} from '@kms545487/contracts';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import {
  STAFF_ATTENDANCE_SPEC,
  USERS_SPEC,
} from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { dateInTimeZone, dayDiff } from '../../common/time.util';
import { AuditService } from '../audit/audit.service';
import type { StaffAccount } from '../users/user.entity';
import { ScheduleReadService } from '../schedule/schedule-read.service';
import {
  countsForTeachingHours,
  teachingMinutesOf,
} from '../schedule/session-accounting.policy';
import {
  STAFF_ATTENDANCE_RECORDS,
  type StaffAttendanceRecord,
} from './staff-attendance.entity';

const STAFF_ROLES = new Set(['instructor', 'manager', 'admin', 'super_admin']);

const kstTime = (value: string | null | undefined): string | undefined => {
  if (value == null) return undefined;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(value));
};

const emptySummary = (): InstructorAttendanceLedgerSummary => ({
  instructors: 0,
  lessonEntries: 0,
  staffEntries: 0,
  teachingMinutes: 0,
  lesson: { present: 0, late: 0, absent: 0, makeup: 0, unmarked: 0 },
  staff: {
    present: 0,
    late: 0,
    absent: 0,
    paid_leave: 0,
    unpaid_leave: 0,
    sick_leave: 0,
    remote_work: 0,
  },
});

@TimedModuleInit()
@Injectable()
export class StaffAttendanceService implements OnModuleInit {
  constructor(
    private readonly store: PostgresCollectionStore,
    private readonly uow: CalendarUnitOfWork,
    private readonly audit: AuditService,
    private readonly scheduleRead: ScheduleReadService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.store.hydrate<StaffAttendanceRecord>(STAFF_ATTENDANCE_SPEC);
  }

  async list(query: StaffAttendanceQuery): Promise<StaffAttendanceRecord[]> {
    this.assertRange(query.from, query.to);
    const rows = await this.store.findActive<StaffAttendanceRecord>(STAFF_ATTENDANCE_SPEC, {
      where: query.staffId == null ? undefined : { staffId: query.staffId },
      orderBy: { field: 'workDate', direction: 'DESC' },
    });
    return rows.filter((row) =>
      row.workDate >= query.from
      && row.workDate <= query.to
      && (query.status == null || row.status === query.status),
    );
  }

  async upsert(input: UpsertStaffAttendanceInput, actorId: number): Promise<StaffAttendanceRecord> {
    this.assertTimeRange(input);
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'user', id: input.staffId }]);
      await this.activeStaffOrThrow(input.staffId);
      const [existing] = await this.store.findActive<StaffAttendanceRecord>(STAFF_ATTENDANCE_SPEC, {
        where: { staffId: input.staffId, workDate: input.workDate },
        limit: 1,
      });
      const normalized = {
        status: input.status,
        checkInAt: input.checkInAt ?? null,
        checkOutAt: input.checkOutAt ?? null,
        memo: input.memo?.trim() || null,
        updatedBy: actorId,
      };
      if (!existing) {
        const created = await this.store.insert<StaffAttendanceRecord>(STAFF_ATTENDANCE_SPEC, {
          staffId: input.staffId,
          workDate: input.workDate,
          ...normalized,
          createdBy: actorId,
        });
        await this.audit.log({
          entity: STAFF_ATTENDANCE_RECORDS,
          entityId: created.id,
          action: 'create',
          actorId,
          changes: this.audit.snapshotOf(created),
          reason: '직원 일별 출결 기록',
        });
        return created;
      }
      const changed = Object.entries(normalized).some(
        ([key, value]) => existing[key as keyof StaffAttendanceRecord] !== value,
      );
      if (!changed) return existing;
      const updated = await this.store.updateIf<StaffAttendanceRecord>(
        STAFF_ATTENDANCE_SPEC,
        existing.id,
        { updatedAt: existing.updatedAt },
        normalized,
      );
      if (!updated) throw new ConflictException('다른 관리자가 출결을 먼저 변경했습니다. 새로고침 후 다시 시도해 주세요.');
      await this.audit.log({
        entity: STAFF_ATTENDANCE_RECORDS,
        entityId: updated.id,
        action: 'update',
        actorId,
        changes: this.audit.diffOf(existing, updated),
        reason: '직원 일별 출결 변경',
      });
      return updated;
    });
  }

  async remove(id: number, reason: string, actorId: number): Promise<{ id: number; deleted: true }> {
    const [initial] = await this.store.findActive<StaffAttendanceRecord>(STAFF_ATTENDANCE_SPEC, {
      where: { id },
      limit: 1,
    });
    if (!initial) throw new NotFoundException(`직원 출결 ${id}을 찾을 수 없습니다.`);
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'user', id: initial.staffId }]);
      const [current] = await this.store.findActive<StaffAttendanceRecord>(STAFF_ATTENDANCE_SPEC, {
        where: { id },
        limit: 1,
      });
      if (!current) throw new NotFoundException(`직원 출결 ${id}을 찾을 수 없습니다.`);
      const deleted = await this.store.remove(STAFF_ATTENDANCE_SPEC, id, actorId);
      if (!deleted) throw new NotFoundException(`직원 출결 ${id}을 찾을 수 없습니다.`);
      await this.audit.log({
        entity: STAFF_ATTENDANCE_RECORDS,
        entityId: id,
        action: 'delete',
        actorId,
        changes: this.audit.snapshotOf(current),
        reason: reason.trim(),
      });
      return { id, deleted: true };
    });
  }

  async instructorLedger(query: InstructorAttendanceLedgerQuery): Promise<InstructorAttendanceLedger> {
    this.assertRange(query.from, query.to);
    await this.scheduleRead.ensureReady();
    const [sessions, staffRows] = await Promise.all([
      this.scheduleRead.listFresh({
        from: query.from,
        to: query.to,
        instructorId: query.instructorId,
      }),
      this.list({
        from: query.from,
        to: query.to,
        staffId: query.instructorId,
      }),
    ]);
    const resources = this.scheduleRead.resources();
    const courseById = new Map(resources.courses.map((course) => [Number(course.id), course]));
    const instructorById = new Map(resources.instructors.map((row) => [Number(row.id), row]));
    const sessionEntries: InstructorAttendanceLedgerEntry[] = sessions
      .filter((session) =>
        session.instructorId != null && (
        session.status === 'held'
        || session.status === 'makeup'
        || session.attendanceRequired
        || session.instructorAttendance != null),
      )
      .map((session) => {
        const course = courseById.get(Number(session.courseId));
        const counts = countsForTeachingHours(session);
        return {
          key: `class_session:${session.id}`,
          source: 'class_session',
          recordId: Number(session.id),
          sessionId: Number(session.id),
          instructorId: Number(session.instructorId),
          instructorName: session.instructorName ?? `강사 ${session.instructorId}`,
          date: session.sessionDate,
          status: session.instructorAttendance ?? 'unmarked',
          courseId: Number(session.courseId),
          courseName: session.courseName,
          subjectId: course == null ? undefined : Number(course.subjectId),
          subjectName: session.subjectName,
          startTime: session.startTime,
          endTime: session.endTime,
          teachingMinutes: counts ? teachingMinutesOf(session) : 0,
          countsForPay: counts,
          memo: session.memo ?? null,
        } satisfies InstructorAttendanceLedgerEntry;
      });
    const dailyEntries: InstructorAttendanceLedgerEntry[] = staffRows
      .filter((row) => instructorById.has(Number(row.staffId)))
      .map((row) => ({
        key: `staff_day:${row.id}`,
        source: 'staff_day',
        recordId: Number(row.id),
        instructorId: Number(row.staffId),
        instructorName: instructorById.get(Number(row.staffId))?.name ?? `강사 ${row.staffId}`,
        date: row.workDate,
        status: row.status,
        startTime: kstTime(row.checkInAt),
        endTime: kstTime(row.checkOutAt),
        teachingMinutes: 0,
        countsForPay: false,
        memo: row.memo ?? null,
      }));
    const needle = query.q?.trim().toLocaleLowerCase('ko') ?? '';
    const entries = [...sessionEntries, ...dailyEntries]
      .filter((entry) => query.subjectId == null || entry.subjectId === query.subjectId)
      .filter((entry) => !needle || [
        entry.instructorName,
        entry.subjectName,
        entry.courseName,
      ].some((value) => value?.toLocaleLowerCase('ko').includes(needle)))
      .sort((a, b) =>
        b.date.localeCompare(a.date)
        || a.instructorName.localeCompare(b.instructorName, 'ko')
        || a.key.localeCompare(b.key),
      );
    return { from: query.from, to: query.to, entries, summary: this.summarize(entries) };
  }

  private summarize(entries: InstructorAttendanceLedgerEntry[]): InstructorAttendanceLedgerSummary {
    const summary = emptySummary();
    const instructors = new Set<number>();
    for (const entry of entries) {
      instructors.add(entry.instructorId);
      if (entry.source === 'class_session') {
        summary.lessonEntries += 1;
        summary.teachingMinutes += entry.teachingMinutes;
        summary.lesson[entry.status as keyof typeof summary.lesson] += 1;
      } else {
        summary.staffEntries += 1;
        summary.staff[entry.status as StaffAttendanceStatus] += 1;
      }
    }
    summary.instructors = instructors.size;
    return summary;
  }

  private async activeStaffOrThrow(staffId: number): Promise<StaffAccount> {
    const [staff] = await this.store.findActive<StaffAccount>(USERS_SPEC, {
      where: { id: staffId, status: 'active' } as Partial<StaffAccount>,
      limit: 1,
    });
    if (!staff || !STAFF_ROLES.has(staff.role)) {
      throw new BadRequestException('활성 직원 계정이 아닙니다.');
    }
    return staff;
  }

  private assertRange(from: string, to: string): void {
    const span = dayDiff(to, from);
    if (span < 0) throw new BadRequestException('종료일은 시작일보다 빠를 수 없습니다.');
    if (span > 366) throw new BadRequestException('조회 기간은 최대 367일입니다.');
  }

  private assertTimeRange(input: UpsertStaffAttendanceInput): void {
    const hasIn = input.checkInAt != null;
    const hasOut = input.checkOutAt != null;
    if (hasIn !== hasOut) throw new BadRequestException('출근·퇴근 시각은 함께 입력해 주세요.');
    if (!hasIn || !hasOut) return;
    const start = new Date(input.checkInAt as string);
    const end = new Date(input.checkOutAt as string);
    if (dateInTimeZone(start) !== input.workDate) {
      throw new BadRequestException('출근 시각의 KST 날짜가 업무일과 일치해야 합니다.');
    }
    const durationMs = end.getTime() - start.getTime();
    if (durationMs <= 0 || durationMs > 86_400_000) {
      throw new BadRequestException('퇴근 시각은 출근 뒤 24시간 이내여야 합니다.');
    }
  }
}
