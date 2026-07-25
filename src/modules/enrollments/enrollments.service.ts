import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ClassSessionsStore } from '../schedule/class-sessions.store'; // [TBO-66 R3]
import { todayKst } from '../../common/time.util'; // [TBO-65 M2]
import { InMemoryDatabase } from '../../database/in-memory.database';
import { COURSES_SPEC, ENROLLMENTS_SPEC, STUDENTS_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { AuditService } from '../audit/audit.service';
import { Enrollment, ENROLLMENTS } from './enrollment.entity';
import { CreateEnrollmentDto } from './dto/create-enrollment.dto';
import { STUDENTS } from '../students/student.entity';
import { Student } from '../students/student.entity';
import { COURSES, StoredCourse } from '../courses/course.entity';
import { ClassSession, SESSIONS } from '../schedule/schedule.entity';
import { buildCohortIndex, studentBelongsToSessionIndexed } from '../schedule/session-participant.policy';
import { isScheduleVisibleStudentStatus } from '../students/student-status.policy';

@Injectable()
export class EnrollmentsService implements OnModuleInit {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
    private readonly uow: CalendarUnitOfWork,
    private readonly audit: AuditService,
    private readonly sessionsStore: ClassSessionsStore, // [TBO-66 R3] completedSessions 파생 입력 재수화
  ) {}

  // 데모 수강 시드 — 프론트 목데이터 이관. studentId→students, courseId→courses(무결성).
  // completedSessions는 진행완료(held) 세션 수와 정합(코스10/11/12 각 2회).
  async onModuleInit(): Promise<void> {
    await this.store.hydrate<Enrollment>(ENROLLMENTS_SPEC);
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

  /** [TBO-54 C2] 목록/상세 READ = DB 권위(행 원부). 파생 completedSessions는 세션
   *  읽기모델(EP2 TTL hydrate — staleness 유계) 기반 — 세션 전환은 후속 청크. */
  async listDb(studentId?: number): Promise<Enrollment[]> {
    await this.sessionsStore.ensureReady(); // [TBO-66 R3] held 파생이 스테일 미러로 계산되던 갭
    const rows = await this.store.findActive<Enrollment>(ENROLLMENTS_SPEC, {
      where: studentId == null ? undefined : ({ studentId } as Partial<Enrollment>),
      orderBy: { field: 'id' },
    });
    return this.withDerivedCompletedSessions(rows);
  }

  async getDb(id: number): Promise<Enrollment> {
    await this.sessionsStore.ensureReady(); // [TBO-66 R3]
    const [row] = await this.store.findActive<Enrollment>(ENROLLMENTS_SPEC, { where: { id } as Partial<Enrollment>, limit: 1 });
    if (!row) throw new NotFoundException(`Enrollment ${id} not found`);
    return this.withDerivedCompletedSessions([row])[0];
  }

  // 결제 없이도 등록 가능 (status=active). actorId 없으면(시드·내부 경로) audit 생략.
  async create(dto: CreateEnrollmentDto, actorId?: number): Promise<Enrollment> {
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'student', id: dto.studentId }, { kind: 'course', id: dto.courseId }]);
      await this.store.hydrate<Student>(STUDENTS_SPEC);
      await this.store.hydrate<StoredCourse>(COURSES_SPEC);
      await this.store.hydrate<Enrollment>(ENROLLMENTS_SPEC);
      // FK·중복 판정은 lock 뒤 실제 DB readback이 권위다.
      if (!this.db.findById(STUDENTS, dto.studentId))
        throw new BadRequestException(`존재하지 않는 학생입니다 (studentId=${dto.studentId})`);
      if (!this.db.findById(COURSES, dto.courseId))
        throw new BadRequestException(`존재하지 않는 코스입니다 (courseId=${dto.courseId})`);
      const duplicate = this.db.findBy<Enrollment>(ENROLLMENTS, (row) =>
        Number(row.studentId) === Number(dto.studentId) && Number(row.courseId) === Number(dto.courseId),
      )[0];
      if (duplicate) throw new ConflictException('이미 연결된 학생과 과목입니다.');
      const row = await this.store.insert<Enrollment>(ENROLLMENTS_SPEC, {
        studentId: dto.studentId,
        courseId: dto.courseId,
        roadmapId: dto.roadmapId,
        status: 'active',
        totalSessions: dto.totalSessions,
        completedSessions: 0,
        memo: dto.memo,
        enrolledAt: todayKst(), // [TBO-65 M2] KST 기준(UTC slice는 자정 부근 하루 어긋남)
      });
      // [감사 전수 2026-07-16] 전 테이블 CRUD 이력(대표 지시)
      if (actorId != null) await this.audit.log({ entity: 'enrollments', entityId: row.id, action: 'create', actorId, changes: this.audit.snapshotOf(row) });
      return row;
    });
  }

  /**
   * 과목명 기반 수업 개설의 roster command. 선택 학생을 같은 course의 활성 enrollment로 보장한다.
   * caller의 outer UoW가 있으면 subject/course/session과 함께 rollback된다.
   */
  async ensureActiveForCourse(studentIds: number[], courseId: number, actorId?: number): Promise<Enrollment[]> {
    const ids = [...new Set(studentIds.map(Number))];
    if (!ids.length) return [];
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'course', id: courseId }, ...ids.map((id) => ({ kind: 'student' as const, id }))]);
      await this.store.hydrate<StoredCourse>(COURSES_SPEC);
      await this.store.hydrate<Student>(STUDENTS_SPEC);
      await this.store.hydrate<Enrollment>(ENROLLMENTS_SPEC);
      if (!this.db.findById<StoredCourse>(COURSES, courseId)) {
        throw new BadRequestException(`존재하지 않는 코스입니다 (courseId=${courseId})`);
      }

      const ensured: Enrollment[] = [];
      for (const studentId of ids) {
        const student = this.db.findById<Student>(STUDENTS, studentId);
        if (!student || !isScheduleVisibleStudentStatus(student.status)) {
          throw new BadRequestException(`수업에 연결할 수 없는 학생입니다 (studentId=${studentId})`);
        }
        const existing = this.db.findBy<Enrollment>(ENROLLMENTS, (row) =>
          Number(row.studentId) === studentId && Number(row.courseId) === courseId,
        )[0];
        if (!existing) {
          const created = await this.store.insert<Enrollment>(ENROLLMENTS_SPEC, {
            studentId,
            courseId,
            status: 'active',
            completedSessions: 0,
            enrolledAt: todayKst(), // [TBO-65 M2] KST 기준(UTC slice는 자정 부근 하루 어긋남)
          });
          if (actorId != null) {
            await this.audit.log({ entity: 'enrollments', entityId: created.id, action: 'create', actorId, changes: this.audit.snapshotOf(created) });
          }
          ensured.push(created);
          continue;
        }
        if (existing.status === 'active') {
          ensured.push(existing);
          continue;
        }
        const before = { ...existing };
        const updated = await this.store.update<Enrollment>(ENROLLMENTS_SPEC, existing.id, {
          status: 'active',
          enrolledAt: todayKst(), // [TBO-65 M2] KST 기준(UTC slice는 자정 부근 하루 어긋남)
        }) as Enrollment;
        if (actorId != null) {
          await this.audit.log({ entity: 'enrollments', entityId: updated.id, action: 'update', actorId, changes: this.audit.diffOf(before, updated) });
        }
        ensured.push(updated);
      }
      return ensured;
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
