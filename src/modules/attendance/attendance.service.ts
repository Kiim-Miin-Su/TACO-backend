import { BadRequestException, ForbiddenException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { sessionStartPassed } from '../schedule/session-time.policy'; // [TBO-65 M1]
import { ClassSessionsStore } from '../schedule/class-sessions.store';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { ATTENDANCE_SPEC } from '../../database/calendar-asset-specs';
import { ENROLLMENTS_SPEC, STUDENTS_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { AuditService } from '../audit/audit.service'; // [출결 이력 2026-07-07] 학생 출결 변경도 audit_log에 기록
import { hasAdminRole } from '../auth/roles.decorator';
import { ClassSession, SESSIONS } from '../schedule/schedule.entity';
import { Student } from '../students/student.entity';
import { Attendance, ATTENDANCE } from './attendance.entity';
import { UpsertAttendanceDto } from './dto/upsert-attendance.dto';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { Enrollment } from '../enrollments/enrollment.entity';
import { studentBelongsToSession } from '../schedule/session-participant.policy';
import { isSessionVisibleToInstructor } from '../schedule/schedule-visibility.policy';

/**
 * [참조/처리] 출결. 프론트 목데이터 이관 + 참조 무결성 게이트.
 *  - 시드 3건(id 1-3): 세션 1(학생 1 present·학생 4 late) · 세션 2(학생 1 present) — 코스10 코호트와 정합.
 *  - upsert: sessionId→class_sessions, studentId→students 존재 검증 후, (session,student) 있으면 status 갱신, 없으면 삽입.
 *    → 한 쌍당 1행 유지(ERD unique(session_id, student_id))로 이중 기록 방지.
 */
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
    if (actorId == null || hasAdminRole(actorRoles)) return rows;
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
  async upsert(dto: UpsertAttendanceDto, actorId?: number, actorRoles?: string[]): Promise<Attendance> {
    return this.unitOfWork.run(async () => {
      // [TBO-56 C2b] session lock + DB 재조회 — 교차 인스턴스 upsert 경쟁을 직렬화(중복 insert 500 경로 제거)
      //  하고, FK·코호트·소유권 판정을 전부 DB 기준으로 내린다(TBO-55 감사 B 항목 해소).
      await this.unitOfWork.lockTargets([{ kind: 'session', id: dto.sessionId }]);
      const session = await this.sessionsStore.findByIdDb(dto.sessionId);
      if (!session) throw new BadRequestException(`sessionId ${dto.sessionId} 없음(존재하지 않는 수업)`);
      const [student] = await this.store.findActive<Student>(STUDENTS_SPEC, { where: { id: dto.studentId } as Partial<Student>, limit: 1 });
      if (!student) throw new BadRequestException(`studentId ${dto.studentId} 없음(존재하지 않는 학생)`);
      const enrollments = await this.store.findActive<Enrollment>(ENROLLMENTS_SPEC);
      if (!studentBelongsToSession(session, dto.studentId, enrollments))
        throw new BadRequestException(`studentId ${dto.studentId}는 세션 ${dto.sessionId}의 수강생이 아닙니다`);
      // 소유권(IDOR 방지) — 비관리자는 담당 강사 세션만. actorId 미상(무인증 컨텍스트)이면 검사 생략.
      const isAdmin = hasAdminRole(actorRoles);
      if (actorId != null && !isAdmin && !isSessionVisibleToInstructor(session, actorId))
        throw new ForbiddenException('담당 강사 또는 관리자만 이 세션의 출결을 기록할 수 있습니다.');

      // [TBO-62 ⑤ 2026-07-24] 출결 기록 = "수업이 진행됐다"는 사실의 단일 진실원 — 시작 시각이 지난
      //  scheduled 세션은 held로 자동 전이한다(운영 실측: 출석·리포트를 기록해도 status가 scheduled로
      //  남아 시수·완료가 안 잡히고, 종료 경과 scheduled는 FE가 '미진행(펑크)→보강 필요'로 오분류).
      //  경계: canceled/no_show/makeup/held는 절대 덮지 않고, 미래 세션(시작 전)은 전이하지 않는다.
      let autoHeld = false; // [TBO-58 P2] 자동 전이 여부 — 로그 1줄에 함께 남긴다(전이 추적)
      // [TBO-65 M1] 시각 경과 판정 = session-time.policy 단일 진실원(readiness와 같은 기준 계열)
      if (session.status === 'scheduled' && sessionStartPassed(session, Date.now())) {
        autoHeld = true;
        await this.sessionsStore.update(session.id, { status: 'held' } as never);
        if (actorId != null) {
          await this.audit.log({
            entity: 'class_sessions', entityId: session.id, action: 'update', actorId,
            changes: { status: { before: 'scheduled', after: 'held' } }, reason: '출결 기록 자동 진행 처리(TBO-62)',
          });
        }
      }

      // (세션, 학생) 유니크 — DB 기준 판별: 있으면 갱신, 없으면 삽입(lock이 교차 인스턴스 경쟁 직렬화).
      const [existing] = await this.store.findActive<Attendance>(ATTENDANCE_SPEC, {
        where: { sessionId: dto.sessionId, studentId: dto.studentId } as Partial<Attendance>, limit: 1,
      });
      if (existing) {
        const before = { ...existing };
        const updated = await this.store.update<Attendance>(ATTENDANCE_SPEC, existing.id, { status: dto.status }) as Attendance;
        if (actorId != null) {
          const diff = this.audit.diffOf(before, updated);
          if (Object.keys(diff).length)
            await this.audit.log({ entity: ATTENDANCE, entityId: updated.id, action: 'update', actorId, changes: diff });
        }
        this.domainLog.log(`action=upsert session=${dto.sessionId} student=${dto.studentId} status=${dto.status} actor=${actorId ?? 0} autoHeld=${autoHeld ? 1 : 0} result=updated`); // [TBO-58 P2]
        return updated;
      }
      const created = await this.store.insert<Attendance>(ATTENDANCE_SPEC, {
        sessionId: dto.sessionId,
        studentId: dto.studentId,
        status: dto.status,
      });
      if (actorId != null)
        await this.audit.log({ entity: ATTENDANCE, entityId: created.id, action: 'create', actorId, changes: this.audit.snapshotOf(created) as never });
      this.domainLog.log(`action=upsert session=${dto.sessionId} student=${dto.studentId} status=${dto.status} actor=${actorId ?? 0} autoHeld=${autoHeld ? 1 : 0} result=created`); // [TBO-58 P2]
      return created;
    });
  }

  async removeBySession(sessionId: number, deletedBy?: number): Promise<number> {
    // [감사 전수 2026-07-16] cascade 삭제도 행별 delete 이력(⚠ 누락 경로였음 — 호출부 tx 안).
    const rows = this.db.findByField<Attendance>(ATTENDANCE, 'sessionId', sessionId);
    const count = await this.store.removeByField(ATTENDANCE_SPEC, 'sessionId', sessionId, deletedBy);
    if (deletedBy != null && deletedBy > 0) {
      for (const r of rows) {
        await this.audit.log({ entity: ATTENDANCE, entityId: r.id, action: 'delete', actorId: deletedBy });
      }
    }
    return count;
  }
}
