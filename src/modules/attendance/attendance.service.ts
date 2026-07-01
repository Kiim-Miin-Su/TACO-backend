import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
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
  constructor(private readonly db: InMemoryDatabase) {}

  onModuleInit(): void {
    this.db.seed<Attendance>(ATTENDANCE, [
      { id: 1, sessionId: 1, studentId: 1, status: 'present' },
      { id: 2, sessionId: 1, studentId: 4, status: 'late' },
      { id: 3, sessionId: 2, studentId: 2, status: 'present' },
    ]);
  }

  findAll(): Attendance[] {
    return this.db.findAll<Attendance>(ATTENDANCE);
  }

  findBySession(sessionId: number): Attendance[] {
    return this.db.findBy<Attendance>(ATTENDANCE, (a) => a.sessionId === sessionId);
  }

  // 출결 기록(upsert). FK 검증 → 기존 (session,student) 행 갱신 or 신규 삽입.
  upsert(dto: UpsertAttendanceDto): Attendance {
    // 1) 세션 FK
    if (!this.db.findById<ClassSession>(SESSIONS, dto.sessionId))
      throw new BadRequestException(`sessionId ${dto.sessionId} 없음(존재하지 않는 수업)`);
    // 2) 학생 FK
    if (!this.db.findById<Student>(STUDENTS, dto.studentId))
      throw new BadRequestException(`studentId ${dto.studentId} 없음(존재하지 않는 학생)`);

    // 3) (세션, 학생) 유니크 — 있으면 갱신, 없으면 삽입
    const [existing] = this.db.findBy<Attendance>(
      ATTENDANCE,
      (a) => a.sessionId === dto.sessionId && a.studentId === dto.studentId,
    );
    if (existing) {
      return this.db.update<Attendance>(ATTENDANCE, existing.id, { status: dto.status }) as Attendance;
    }
    return this.db.insert<Attendance>(ATTENDANCE, {
      sessionId: dto.sessionId,
      studentId: dto.studentId,
      status: dto.status,
    });
  }
}
