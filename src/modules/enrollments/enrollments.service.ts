import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ClassSessionsStore } from '../schedule/class-sessions.store'; // [TBO-66 R3]
import { todayKst } from '../../common/time.util'; // [TBO-65 M2]
import { InMemoryDatabase } from '../../database/in-memory.database';
import {
  COURSES_SPEC,
  ENROLLMENTS_SPEC,
  ROADMAP_COURSES_SPEC,
  ROADMAPS_SPEC,
  STUDENTS_SPEC,
} from '../../database/calendar-asset-specs';
import { COUNSEL_FORMS_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { AuditService } from '../audit/audit.service';
import { Enrollment, ENROLLMENTS } from './enrollment.entity';
import { CreateEnrollmentDto } from './dto/create-enrollment.dto';
import { UpdateEnrollmentDto } from './dto/update-enrollment.dto';
import { STUDENTS } from '../students/student.entity';
import { Student } from '../students/student.entity';
import { COURSES, StoredCourse } from '../courses/course.entity';
import { ClassSession, SESSIONS } from '../schedule/schedule.entity';
import { isScheduleVisibleStudentStatus } from '../students/student-status.policy';
import { CounselForm } from '../counsel/counsel.entity';
import { enrollmentIncludesSessionDate, enrollmentLifecyclePatch } from './enrollment-lifecycle.policy';
import type { Roadmap, RoadmapCourse } from '../roadmaps/roadmap.entity';

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
      await this.uow.lockTargets([
        { kind: 'student', id: dto.studentId },
        { kind: 'course', id: dto.courseId },
        ...(dto.counselCardId == null ? [] : [{ kind: 'counselForm' as const, id: dto.counselCardId }]),
        ...(dto.roadmapId == null ? [] : [{ kind: 'roadmap' as const, id: dto.roadmapId }]),
      ]);
      await this.store.hydrate<Student>(STUDENTS_SPEC);
      await this.store.hydrate<StoredCourse>(COURSES_SPEC);
      await this.store.hydrate<Enrollment>(ENROLLMENTS_SPEC);
      if (dto.counselCardId != null) await this.store.hydrate<CounselForm>(COUNSEL_FORMS_SPEC);
      // FK·중복 판정은 lock 뒤 실제 DB readback이 권위다.
      const student = this.db.findById<Student>(STUDENTS, dto.studentId);
      if (!student)
        throw new BadRequestException(`존재하지 않는 학생입니다 (studentId=${dto.studentId})`);
      if (!isScheduleVisibleStudentStatus(student.status))
        throw new BadRequestException(`수업에 연결할 수 없는 학생입니다 (studentId=${dto.studentId})`);
      if (!this.db.findById(COURSES, dto.courseId))
        throw new BadRequestException(`존재하지 않는 코스입니다 (courseId=${dto.courseId})`);
      if (dto.startDate && dto.endDate && dto.endDate < dto.startDate)
        throw new BadRequestException('수강 종료일은 시작일보다 빠를 수 없습니다.');
      if (dto.counselCardId != null) {
        const [counsel] = await this.store.findActive<CounselForm>(COUNSEL_FORMS_SPEC, {
          where: { id: dto.counselCardId },
          limit: 1,
        });
        if (!counsel || Number(counsel.studentId) !== Number(dto.studentId))
          throw new BadRequestException('상담카드가 없거나 대상 학생과 일치하지 않습니다.');
      }
      if (dto.roadmapId != null) {
        const [roadmap] = await this.store.findActive<Roadmap>(ROADMAPS_SPEC, {
          where: { id: dto.roadmapId } as Partial<Roadmap>,
          limit: 1,
        });
        if (!roadmap || roadmap.isActive !== true)
          throw new BadRequestException('활성 로드맵이 없거나 더 이상 수강에 사용할 수 없습니다.');
        const [link] = await this.store.findActive<RoadmapCourse>(ROADMAP_COURSES_SPEC, {
          where: { roadmapId: dto.roadmapId, courseId: dto.courseId } as Partial<RoadmapCourse>,
          limit: 1,
        });
        if (!link)
          throw new BadRequestException('선택한 코스가 해당 로드맵에 포함되어 있지 않습니다.');
      }
      const duplicate = this.db.findBy<Enrollment>(ENROLLMENTS, (row) =>
        Number(row.studentId) === Number(dto.studentId) && Number(row.courseId) === Number(dto.courseId),
      )[0];
      if (duplicate) throw new ConflictException('이미 연결된 학생과 과목입니다.');
      const row = await this.store.insert<Enrollment>(ENROLLMENTS_SPEC, {
        studentId: dto.studentId,
        courseId: dto.courseId,
        counselCardId: dto.counselCardId,
        roadmapId: dto.roadmapId,
        status: 'active',
        startDate: dto.startDate,
        endDate: dto.endDate,
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

  async update(id: number, dto: UpdateEnrollmentDto, actorId: number): Promise<Enrollment> {
    await this.sessionsStore.ensureReady();
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'enrollment', id }]);
      const [current] = await this.store.findActive<Enrollment>(ENROLLMENTS_SPEC, {
        where: { id },
        limit: 1,
      });
      if (!current) throw new NotFoundException(`Enrollment ${id} not found`);

      const hydrated = this.withDerivedCompletedSessions([current])[0];
      const patch = enrollmentLifecyclePatch(hydrated, dto, hydrated.completedSessions ?? 0);
      const updated = await this.store.updateIf<Enrollment>(
        ENROLLMENTS_SPEC,
        id,
        { status: current.status },
        patch,
      );
      if (!updated) throw new ConflictException('다른 사용자가 수강 정보를 먼저 변경했습니다. 새로고침 후 다시 시도해 주세요.');
      await this.audit.log({
        entity: 'enrollments',
        entityId: id,
        action: 'update',
        actorId,
        changes: this.audit.diffOf(current, updated),
        reason: dto.reason.trim(),
      });
      return this.withDerivedCompletedSessions([updated])[0];
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

  // [TBO-77 E-2] 완료 회차는 enrollment 자체의 기간과 당시 세션 코호트가 권위다.
  // held 세션을 코스별로 한 번 그룹핑한 뒤, 시작일(없으면 enrolledAt)~종료일과 명시
  // studentIds를 적용한다. 현재 활성 수강 목록을 쓰면 오늘 등록한 학생에게 과거 회차가
  // 소급되거나 completed/canceled 수강의 역사 회차가 0이 되므로 사용하지 않는다.
  private withDerivedCompletedSessions(rows: Enrollment[]): Enrollment[] {
    if (!rows.length) return rows;
    const heldByCourse = new Map<number, ClassSession[]>();
    for (const session of this.db.findByField<ClassSession>(SESSIONS, 'status', 'held')) {
      if (!heldByCourse.has(session.courseId)) heldByCourse.set(session.courseId, []);
      heldByCourse.get(session.courseId)!.push(session);
    }
    return rows.map((row) => ({
      ...row,
      completedSessions: (heldByCourse.get(row.courseId) ?? []).filter((session) => {
        if (!enrollmentIncludesSessionDate(row, session.sessionDate)) return false;
        return !session.studentIds?.length || session.studentIds.map(Number).includes(Number(row.studentId));
      }).length,
    }));
  }
}
