import { BadRequestException, ForbiddenException, Injectable, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { AuditService } from '../audit/audit.service'; // [출결 이력 2026-07-07] 학생 출결 변경도 audit_log에 기록
import { ADMIN_ROLES } from '../auth/roles.decorator';
import { ClassSession, SESSIONS } from '../schedule/schedule.entity';
import { Student, STUDENTS } from '../students/student.entity';
import { Attendance, ATTENDANCE } from './attendance.entity';
import { UpsertAttendanceDto } from './dto/upsert-attendance.dto';

/**
 * [참조/처리] 출결. 프론트 목데이터 이관 + 참조 무결성 게이트.
 *  - 시드 3건(id 1-3): 세션 1(학생 1 present·학생 4 late) · 세션 2(학생 2 present) — class_sessions/students와 정합.
 *  - upsert: sessionId→class_sessions, studentId→students 존재 검증 후, (session,student) 있으면 status 갱신, 없으면 삽입.
 *    → 한 쌍당 1행 유지(ERD unique(session_id, student_id))로 이중 기록 방지.
 */
@Injectable()
export class AttendanceService implements OnModuleInit {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly audit: AuditService, // 출결 변경 이력(tx 동반)
  ) {}

  onModuleInit(): void {
    this.db.seed<Attendance>(ATTENDANCE, [
      { id: 1, sessionId: 1, studentId: 1, status: 'present' },
      { id: 2, sessionId: 1, studentId: 4, status: 'late' },
      { id: 3, sessionId: 2, studentId: 2, status: 'present' },
      // 과거 held 세션(20~28, schedule 히스토리 시드)의 학생 출결 — 강사/학생 출결 대시보드 데모.
      // 코호트 정합: 코스10→{1,4}, 코스11→{2}, 코스12→{1}.
      { id: 4, sessionId: 20, studentId: 1, status: 'present' },
      { id: 5, sessionId: 20, studentId: 4, status: 'late' },
      { id: 6, sessionId: 21, studentId: 2, status: 'present' },
      { id: 7, sessionId: 22, studentId: 1, status: 'present' },
      { id: 8, sessionId: 26, studentId: 1, status: 'present' },
      { id: 9, sessionId: 26, studentId: 4, status: 'present' },
      { id: 10, sessionId: 27, studentId: 2, status: 'absent' },
      { id: 11, sessionId: 28, studentId: 1, status: 'present' },
    ]);
  }

  findAll(): Attendance[] {
    return this.db.findAll<Attendance>(ATTENDANCE);
  }

  findBySession(sessionId: number): Attendance[] {
    return this.db.findByField<Attendance>(ATTENDANCE, 'sessionId', sessionId); // 인덱스 조회
  }

  // 출결 기록(upsert). FK 검증 → 기존 (session,student) 행 갱신 or 신규 삽입.
  // [출결 이력 2026-07-07] 변경(create/update)을 audit_log에 기록(강사 출결이 세션 PATCH로 audit되는 것과 대칭).
  //  actorId·actorRoles(JWT sub·roles)는 컨트롤러가 전달. upsert+audit을 한 tx로(이력 포함 원자성).
  //  [보안 2026-07-07 H1] 소유권 검증(IDOR 차단): 비관리자(강사)는 **본인 담당 세션**의 출결만 기록 가능.
  //   관리자(ADMIN_ROLES)는 전 세션 허용. FE canStudent(=admin||ownSession)와 서버측 정합.
  async upsert(dto: UpsertAttendanceDto, actorId?: number, actorRoles?: string[]): Promise<Attendance> {
    // 1) 세션 FK
    const session = this.db.findById<ClassSession>(SESSIONS, dto.sessionId);
    if (!session) throw new BadRequestException(`sessionId ${dto.sessionId} 없음(존재하지 않는 수업)`);
    // 2) 학생 FK
    if (!this.db.findById<Student>(STUDENTS, dto.studentId))
      throw new BadRequestException(`studentId ${dto.studentId} 없음(존재하지 않는 학생)`);
    // 3) 소유권(IDOR 방지) — 비관리자는 담당 강사 세션만. actorId 미상(무인증 컨텍스트)이면 검사 생략.
    const isAdmin = (actorRoles ?? []).some((r) => (ADMIN_ROLES as string[]).includes(r));
    if (actorId != null && !isAdmin && session.instructorId !== actorId)
      throw new ForbiddenException('담당 강사 또는 관리자만 이 세션의 출결을 기록할 수 있습니다.');

    return this.db.transaction(() => {
      // 3) (세션, 학생) 유니크 — 있으면 갱신, 없으면 삽입
      const [existing] = this.db.findBy<Attendance>(
        ATTENDANCE,
        (a) => a.sessionId === dto.sessionId && a.studentId === dto.studentId, // (upsert 판별은 2키라 predicate 유지)
      );
      if (existing) {
        const before = { ...existing };
        const updated = this.db.update<Attendance>(ATTENDANCE, existing.id, { status: dto.status }) as Attendance;
        if (actorId != null) {
          const diff = this.audit.diffOf(before, updated);
          if (Object.keys(diff).length)
            this.audit.log({ entity: ATTENDANCE, entityId: updated.id, action: 'update', actorId, changes: diff });
        }
        return updated;
      }
      const created = this.db.insert<Attendance>(ATTENDANCE, {
        sessionId: dto.sessionId,
        studentId: dto.studentId,
        status: dto.status,
      });
      if (actorId != null)
        this.audit.log({ entity: ATTENDANCE, entityId: created.id, action: 'create', actorId, changes: this.audit.snapshotOf(created) as never });
      return created;
    });
  }
}
