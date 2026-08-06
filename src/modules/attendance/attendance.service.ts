import { TimedModuleInit } from '../../common/performance-timing';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ClassSessionsStore } from '../schedule/class-sessions.store';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { ATTENDANCE_SPEC } from '../../database/calendar-asset-specs';
import { ENROLLMENTS_SPEC, STUDENTS_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { AuditService } from '../audit/audit.service'; // [출결 이력 2026-07-07] 학생 출결 변경도 audit_log에 기록
import { hasAdminRole } from '../auth/roles.decorator';
import type { RoleCapability } from '@kms545487/contracts';
import { ClassSession, SESSIONS } from '../schedule/schedule.entity';
import { Student } from '../students/student.entity';
import { Attendance, ATTENDANCE } from './attendance.entity';
import { UpsertAttendanceDto } from './dto/upsert-attendance.dto';
import {
  CalendarUnitOfWork,
  sessionAccountingLockKeys,
} from '../../database/calendar-unit-of-work.service';
import { Enrollment } from '../enrollments/enrollment.entity';
import { studentBelongsToSession } from '../schedule/session-participant.policy';
import { buildCohortIndex } from '../schedule/session-participant.policy';
import { isSessionVisibleToInstructor } from '../schedule/schedule-visibility.policy';
import {
  attendanceCompletionHoldPatch,
  TEMPORAL_RESET_AUDIT_REASON,
} from '../schedule/session-temporal-transition.policy';
import { isPayoutLocked } from '../schedule/session-accounting.policy';
import { SessionAccountingContextService } from '../schedule/session-accounting-context.service'; // [TBO-79 B4]
import { SessionAccountingGuard, type AccountingAckInput } from '../schedule/session-accounting-guard.service'; // [TBO-79 B4]

/**
 * [참조/처리] 출결. 프론트 목데이터 이관 + 참조 무결성 게이트.
 *  - 시드 3건(id 1-3): 세션 1(학생 1 present·학생 4 late) · 세션 2(학생 1 present) — 코스10 코호트와 정합.
 *  - upsert: sessionId→class_sessions, studentId→students 존재 검증 후, (session,student) 있으면 status 갱신, 없으면 삽입.
 *    → 한 쌍당 1행 유지(ERD unique(session_id, student_id))로 이중 기록 방지.
 */
@TimedModuleInit()
@Injectable()
export class AttendanceService implements OnModuleInit {
  // [TBO-58 P2] 도메인 command 1줄 로그 — [money] 패턴 확장(allowlist: id·상태만, 이름 없음)
  private readonly domainLog = new Logger('attendance');

  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
    private readonly audit: AuditService, // 출결 변경 이력(tx 동반)
    private readonly unitOfWork: CalendarUnitOfWork,
    private readonly sessionsStore: ClassSessionsStore, // [TBO-56 C2b] 세션 DB 재조회·스코프 판정
    private readonly accountingContext: SessionAccountingContextService, // [TBO-79 B4] 잠금 후 fresh 스냅샷
    private readonly accountingGuard: SessionAccountingGuard, // [TBO-79 B4] 영향 미리보기 + ack 집행
  ) {}

  async onModuleInit(): Promise<void> {
    await this.store.hydrate<Attendance>(ATTENDANCE_SPEC);
  }

  findAll(): Attendance[] {
    return this.db.findAll<Attendance>(ATTENDANCE);
  }

  findBySession(sessionId: number): Attendance[] {
    return this.db.findByField<Attendance>(ATTENDANCE, 'sessionId', sessionId); // 인덱스 조회
  }

  /** [TBO-56 C2b] 목록 READ = DB 권위(행) + 강사 스코프는 세션 재수화 후 판정(교차 인스턴스 즉시 반영). */
  async listDbForActor(actorId?: number, actorRoles?: string[], sessionId?: number): Promise<Attendance[]> {
    const rows = await this.store.findActive<Attendance>(ATTENDANCE_SPEC, {
      where: sessionId == null ? undefined : ({ sessionId } as Partial<Attendance>),
      orderBy: { field: 'id' },
    });
    // [TBO-79 D5] fail-closed. 종전엔 `actorId == null`이면 **전 출결 행**을 그대로 반환했다.
    //  현재 가드가 req.user를 보장해 도달 불가하지만, 권한 코드에 fail-open 기본값을 두면
    //  @Public 라우트 하나·내부 호출 하나가 곧바로 전수 유출이 된다.
    if (actorId == null) throw new ForbiddenException('출결 조회에는 로그인 사용자 정보가 필요합니다.');
    if (hasAdminRole(actorRoles)) return rows;
    await this.sessionsStore.ensureReady(); // 세션 가시성 판정도 DB 기준
    if (sessionId != null) {
      const session = this.db.findById<ClassSession>(SESSIONS, sessionId);
      if (session && !isSessionVisibleToInstructor(session, actorId))
        throw new ForbiddenException('담당 강사 또는 관리자만 이 세션의 출결을 조회할 수 있습니다.');
      return rows;
    }
    const ownSessionIds = new Set(
      this.db.findByField<ClassSession>(SESSIONS, 'instructorId', actorId)
        .filter((session) => isSessionVisibleToInstructor(session, actorId))
        .map((s) => Number(s.id)),
    );
    return rows.filter((a) => ownSessionIds.has(Number(a.sessionId)));
  }

  // 출결 기록(upsert). FK 검증 → 기존 (session,student) 행 갱신 or 신규 삽입.
  // [출결 이력 2026-07-07] 변경(create/update)을 audit_log에 기록(강사 출결이 세션 PATCH로 audit되는 것과 대칭).
  //  actorId·actorRoles(JWT sub·roles)는 컨트롤러가 전달. upsert+audit을 한 tx로(이력 포함 원자성).
  //  [보안 2026-07-07 H1] 소유권 검증(IDOR 차단): 비관리자(강사)는 **본인 담당 세션**의 출결만 기록 가능.
  //   관리자(ADMIN_ROLES)는 전 세션 허용. FE canStudent(=admin||ownSession)와 서버측 정합.
  async upsert(dto: UpsertAttendanceDto, actorId?: number, actorCapabilities?: RoleCapability[]): Promise<Attendance> {
    return this.unitOfWork.run(async () => {
      // [TBO-56 C2b] session lock + DB 재조회 — 교차 인스턴스 upsert 경쟁을 직렬화(중복 insert 500 경로 제거)
      //  하고, FK·코호트·소유권 판정을 전부 DB 기준으로 내린다(TBO-55 감사 B 항목 해소).
      const { session, enrollments } = await this.commandContext(
        dto.sessionId,
        dto.studentId,
        actorId,
        actorCapabilities,
      );

      // (세션, 학생) 유니크 — DB 기준 판별: 있으면 갱신, 없으면 삽입(lock이 교차 인스턴스 경쟁 직렬화).
      const [existing] = await this.store.findActive<Attendance>(ATTENDANCE_SPEC, {
        where: { sessionId: dto.sessionId, studentId: dto.studentId } as Partial<Attendance>, limit: 1,
      });
      let saved: Attendance;
      let result: 'created' | 'updated';
      if (existing) {
        const before = { ...existing };
        saved = await this.store.update<Attendance>(ATTENDANCE_SPEC, existing.id, { status: dto.status }) as Attendance;
        result = 'updated';
        if (actorId != null) {
          const diff = this.audit.diffOf(before, saved);
          if (Object.keys(diff).length)
            await this.audit.log({ entity: ATTENDANCE, entityId: saved.id, action: 'update', actorId, changes: diff });
        }
      } else {
        saved = await this.store.insert<Attendance>(ATTENDANCE_SPEC, {
          sessionId: dto.sessionId,
          studentId: dto.studentId,
          status: dto.status,
        });
        result = 'created';
        if (actorId != null)
          await this.audit.log({ entity: ATTENDANCE, entityId: saved.id, action: 'create', actorId, changes: this.audit.snapshotOf(saved) as never });
      }

      const activeAttendance = await this.store.findActive<Attendance>(ATTENDANCE_SPEC, {
        where: { sessionId: dto.sessionId } as Partial<Attendance>,
      });
      const holdPatch = attendanceCompletionHoldPatch(
        session,
        buildCohortIndex(enrollments),
        activeAttendance,
        Date.now(),
      );
      const autoHeld = holdPatch != null;
      if (holdPatch) {
        await this.sessionsStore.update(session.id, holdPatch as never);
        if (actorId != null) {
          await this.audit.log({
            entity: 'class_sessions', entityId: session.id, action: 'update', actorId,
            changes: {
              status: { before: 'scheduled', after: 'held' },
              // [TBO-79 D1] 참가자 확정도 감사 대상 — 과거 회차의 코호트가 언제 굳었는지 추적된다.
              ...(holdPatch.studentIds ? { studentIds: { before: session.studentIds ?? [], after: holdPatch.studentIds } } : {}),
            },
            reason: '강사와 수강생 출결 완결 자동 진행 처리',
          });
        }
      }
      this.domainLog.log(`action=upsert session=${dto.sessionId} student=${dto.studentId} status=${dto.status} actor=${actorId ?? 0} autoHeld=${autoHeld ? 1 : 0} result=${result}`);
      return saved;
    });
  }

  async clear(
    sessionId: number,
    studentId: number,
    reason: string,
    actorId?: number,
    actorCapabilities?: RoleCapability[],
    ack?: AccountingAckInput,
  ): Promise<{ id: number; sessionId: number; studentId: number; deleted: true }> {
    return this.unitOfWork.run(async () => {
      await this.unitOfWork.lockTargets(sessionAccountingLockKeys({ sessionIds: [sessionId] }));
      const { session } = await this.commandContext(
        sessionId,
        studentId,
        actorId,
        actorCapabilities,
        false,
      );
      if (isPayoutLocked(session)) {
        throw new BadRequestException('정산에 연결되거나 지급 완료된 수업의 출결은 정산 회수 후 초기화할 수 있습니다.');
      }
      const [existing] = await this.store.findActive<Attendance>(ATTENDANCE_SPEC, {
        where: { sessionId, studentId } as Partial<Attendance>,
        limit: 1,
      });
      if (!existing) throw new NotFoundException('초기화할 학생 출결 기록이 없습니다.');

      // [TBO-79 B4] held → scheduled 역전이는 PATCH /schedule과 같은 정산 델타를 만든다.
      //  종전엔 이 경로에만 게이트가 없어, 권한이 더 낮은 담당 강사가 확인 없이 정산 예상액을
      //  바꿀 수 있었다. 잠금 스냅샷에서 계산해야 미리보기와 실제 적용 대상이 결속된다.
      const resetsSession = session.status === 'held';
      const accountingContext = await this.accountingContext.loadFresh([sessionId]);
      const evaluated = await this.accountingGuard.evaluate({
        context: accountingContext,
        sessionId,
        before: session,
        after: resetsSession ? { ...session, status: 'scheduled' } : session,
        removesAttendanceForStudentIds: [studentId],
      });
      const acknowledged = this.accountingGuard.assertAcknowledged(session, evaluated, ack, {
        locked: '정산에 연결된 수업의 출결은 정산 회수 후 초기화할 수 있습니다.',
        ack: '출결 초기화로 시수 또는 정산 예상액이 달라집니다. 변경 결과를 확인해 주세요.',
      });

      const deleted = await this.store.remove(ATTENDANCE_SPEC, existing.id, actorId);
      if (!deleted) throw new NotFoundException('초기화할 학생 출결 기록이 없습니다.');
      if (actorId != null) {
        await this.audit.log({
          entity: ATTENDANCE,
          entityId: existing.id,
          action: 'delete',
          actorId,
          reason,
        });
      }
      if (resetsSession) {
        await this.sessionsStore.update(session.id, { status: 'scheduled' });
        if (actorId != null) {
          await this.audit.log({
            entity: SESSIONS,
            entityId: session.id,
            action: 'update',
            actorId,
            changes: {
              status: { before: 'held', after: 'scheduled' },
              // [TBO-79 B6] "무엇을 보고 승인했는가"를 재구성 가능하게 — schedule과 동일 규약.
              ...(acknowledged ? this.accountingGuard.acknowledgementDiff(evaluated) : {}),
            },
            reason: '학생 출결 초기화에 따른 완료 상태 해제',
          });
        }
      }
      this.domainLog.log(
        `action=clear session=${sessionId} student=${studentId} actor=${actorId ?? 0} sessionReset=${session.status === 'held' ? 1 : 0} result=deleted`,
      );
      return { id: existing.id, sessionId, studentId, deleted: true };
    });
  }

  private async commandContext(
    sessionId: number,
    studentId: number,
    actorId?: number,
    actorCapabilities?: RoleCapability[],
    lock = true,
  ): Promise<{ session: ClassSession; enrollments: Enrollment[] }> {
    if (lock) {
      await this.unitOfWork.lockTargets(sessionAccountingLockKeys({ sessionIds: [sessionId] }));
    }
    const session = await this.sessionsStore.findByIdDb(sessionId);
    if (!session) throw new BadRequestException(`sessionId ${sessionId} 없음(존재하지 않는 수업)`);
    const [student] = await this.store.findActive<Student>(STUDENTS_SPEC, {
      where: { id: studentId } as Partial<Student>,
      limit: 1,
    });
    if (!student) throw new BadRequestException(`studentId ${studentId} 없음(존재하지 않는 학생)`);
    const enrollments = await this.store.findActive<Enrollment>(ENROLLMENTS_SPEC);
    if (!studentBelongsToSession(session, studentId, enrollments)) {
      throw new BadRequestException(`studentId ${studentId}는 세션 ${sessionId}의 수강생이 아닙니다`);
    }
    // [TBO-79 D5] fail-closed — 종전 `actorId != null &&`는 actor 미상 호출이 소유권 검사를 통째로
    //  건너뛰게 했다. 관리자 판정은 그대로 통과 경로다.
    if (actorId == null) throw new ForbiddenException('출결 기록에는 로그인 사용자 정보가 필요합니다.');
    if (!actorCapabilities?.includes('session-attendance.manage')) {
      throw new ForbiddenException('학생 출결 변경은 수업 출결 관리 권한이 필요합니다.');
    }
    return { session, enrollments };
  }

  async removeBySession(sessionId: number, deletedBy?: number, reason?: string): Promise<number> {
    // [감사 전수 2026-07-16] cascade 삭제도 행별 delete 이력(⚠ 누락 경로였음 — 호출부 tx 안).
    const rows = await this.store.findActive<Attendance>(ATTENDANCE_SPEC, {
      where: { sessionId } as Partial<Attendance>,
      orderBy: { field: 'id' },
    });
    const count = await this.store.removeByField(ATTENDANCE_SPEC, 'sessionId', sessionId, deletedBy);
    if (deletedBy != null && deletedBy > 0) {
      for (const r of rows) {
        await this.audit.log({
          entity: ATTENDANCE,
          entityId: r.id,
          action: 'delete',
          actorId: deletedBy,
          reason: reason ?? TEMPORAL_RESET_AUDIT_REASON,
        });
      }
    }
    return count;
  }
}
