import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { ENROLLMENTS_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { Enrollment, ENROLLMENTS } from './enrollment.entity';
import { CreateEnrollmentDto } from './dto/create-enrollment.dto';
import { STUDENTS } from '../students/student.entity';
import { COURSES } from '../courses/course.entity';
import { ClassSession, SESSIONS } from '../schedule/schedule.entity';
import { buildCohortIndex, studentBelongsToSessionIndexed } from '../schedule/session-participant.policy';

@Injectable()
export class EnrollmentsService implements OnModuleInit {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
  ) {}

  // 데모 수강 시드 — 프론트 목데이터 이관. studentId→students, courseId→courses(무결성).
  // completedSessions는 진행완료(held) 세션 수와 정합(코스10/11/12 각 2회).
  async onModuleInit(): Promise<void> {
    const hydrated = await this.store.hydrate<Enrollment>(ENROLLMENTS_SPEC);
    if (hydrated.length || this.db.findAll<Enrollment>(ENROLLMENTS).length) return;
    await this.store.seed<Enrollment>(ENROLLMENTS_SPEC, [
      { id: 1, studentId: 1, courseId: 10, status: 'active', totalSessions: 16, completedSessions: 2, enrolledAt: '2026-06-17' },
      { id: 2, studentId: 2, courseId: 11, status: 'active', totalSessions: 20, completedSessions: 2, enrolledAt: '2026-06-16' },
      { id: 3, studentId: 4, courseId: 10, status: 'active', totalSessions: 16, completedSessions: 2, enrolledAt: '2026-06-17' },
      { id: 4, studentId: 1, courseId: 12, status: 'active', totalSessions: 12, completedSessions: 2, enrolledAt: '2026-06-22' },
    ]);
  }

  findAll(): Enrollment[] {
    return this.withDerivedCompletedSessions(this.db.findAll<Enrollment>(ENROLLMENTS));
  }

  findByStudent(studentId: number): Enrollment[] {
    // [EP1] 인덱스 조회(studentId) — 종전 findBy 전체 스캔.
    return this.withDerivedCompletedSessions(this.db.findByField<Enrollment>(ENROLLMENTS, 'studentId', studentId));
  }

  findOne(id: number): Enrollment {
    const row = this.db.findById<Enrollment>(ENROLLMENTS, id);
    if (!row) throw new NotFoundException(`Enrollment ${id} not found`);
    return this.withDerivedCompletedSessions([row])[0];
  }

  // 결제 없이도 등록 가능 (status=active)
  create(dto: CreateEnrollmentDto): Promise<Enrollment> {
    // [감사 H3] FK 존재 검증 — 고아 수강이 스케줄 코호트(activeStudentIds)에 유령 학생을 만드는 것 방지.
    if (!this.db.findById(STUDENTS, dto.studentId))
      throw new BadRequestException(`존재하지 않는 학생입니다 (studentId=${dto.studentId})`);
    if (!this.db.findById(COURSES, dto.courseId))
      throw new BadRequestException(`존재하지 않는 코스입니다 (courseId=${dto.courseId})`);
    return this.store.insert<Enrollment>(ENROLLMENTS_SPEC, {
      studentId: dto.studentId,
      courseId: dto.courseId,
      roadmapId: dto.roadmapId,
      status: 'active',
      totalSessions: dto.totalSessions,
      completedSessions: 0,
      memo: dto.memo,
      enrolledAt: new Date().toISOString().slice(0, 10),
    });
  }

  // [EP1 2026-07-16] 파생 N² 제거 — 종전엔 **행마다** enrollments findAll + 세션 전체 스캔
  //  (O(수강×(수강+세션)), useAppData가 구독하는 핫패스). 지금은 호출당 1회:
  //  ① 활성 수강 코호트 인덱스(courseId→studentId Set — 정책은 session-participant.policy 단일 소스)
  //  ② held 세션을 courseId로 그룹핑(status 세컨더리 인덱스 조회 1회)
  //  → 행별 판정은 자기 코스의 held 세션만 O(1) 멤버십 체크. 의미(명시 코호트 우선)는 동일.
  private withDerivedCompletedSessions(rows: Enrollment[]): Enrollment[] {
    if (!rows.length) return rows;
    const cohortIndex = buildCohortIndex(this.db.findAll<Enrollment>(ENROLLMENTS));
    const heldByCourse = new Map<number, ClassSession[]>();
    for (const session of this.db.findByField<ClassSession>(SESSIONS, 'status', 'held')) {
      if (!heldByCourse.has(session.courseId)) heldByCourse.set(session.courseId, []);
      heldByCourse.get(session.courseId)!.push(session);
    }
    return rows.map((row) => ({
      ...row,
      completedSessions: (heldByCourse.get(row.courseId) ?? []).filter((session) =>
        studentBelongsToSessionIndexed(session, row.studentId, cohortIndex),
      ).length,
    }));
  }
}
