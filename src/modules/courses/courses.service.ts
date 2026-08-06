import { TimedModuleInit } from '../../common/performance-timing';
import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { createHash } from 'crypto';
import { InMemoryDatabase } from '../../database/in-memory.database';
import {
  COURSES_SPEC,
  ENROLLMENTS_SPEC,
  ROADMAP_COURSES_SPEC,
  STUDENT_INTERESTS_SPEC,
  SUBJECTS_SPEC,
  USERS_SPEC,
} from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { CalendarUnitOfWork, type CalendarLockKey } from '../../database/calendar-unit-of-work.service';
import { ClassSessionsStore } from '../schedule/class-sessions.store';
import { AuditService } from '../audit/audit.service';
import { Subject, SUBJECTS } from '../subjects/subject.entity';
import { StaffAccount, USERS, isActiveInstructor } from '../users/user.entity';
import { Enrollment } from '../enrollments/enrollment.entity';
import { StudentInterest } from '../students/student-interest.entity';
import { ROADMAP_COURSES, RoadmapCourse } from '../roadmaps/roadmap.entity';
import { Course, COURSES, StoredCourse } from './course.entity';
import { CreateCourseDto } from './dto/create-course.dto';
import { UpdateCourseDto } from './dto/update-course.dto';
import { InstructorProfilesStore } from '../users/instructor-profiles.store';
import { withEffectiveCourseRate } from './course-pay.resolver';

export type InstructorCourseView = Omit<Course, 'price' | 'hourlyRate' | 'hourlyRateOverride'>;

@TimedModuleInit()
@Injectable()
export class CoursesService implements OnModuleInit {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
    private readonly uow: CalendarUnitOfWork,
    private readonly sessions: ClassSessionsStore,
    private readonly audit: AuditService,
    private readonly profiles: InstructorProfilesStore,
  ) {}

  // 페이 SSOT는 instructor_profiles.default_hourly_rate이며 course별 override는 DB 행만 권위로 사용한다.
  async onModuleInit(): Promise<void> {
    await this.store.hydrate<StoredCourse>(COURSES_SPEC);
  }

  findAll(): Course[] {
    return this.db.findAll<StoredCourse>(COURSES).map((course) => this.effective(course));
  }

  /**
   * 서버리스의 다른 인스턴스에서 생성·수정한 코스를 HTTP read model에 반영한다.
   * 명령 경로는 reloadCommandState()가 항상 DB를 다시 읽고, 조회 경로는 이 메서드가
   * PostgreSQL → 메모리 투영을 갱신한 뒤 응답하므로 인스턴스 로컬 캐시가 권위가 되지 않는다.
   */
  async findAllFresh(): Promise<Course[]> {
    await Promise.all([
      this.store.hydrate<StoredCourse>(COURSES_SPEC),
      this.profiles.hydrate(),
    ]);
    return this.findAll();
  }

  /** 회계 command의 단일 transaction 안에서 호출하는 순차 fresh read. */
  async refreshAccountingRatesFresh(): Promise<void> {
    await this.store.hydrate<StoredCourse>(COURSES_SPEC);
    await this.profiles.hydrate();
  }

  async findAllFreshForActor(instructorOnly: boolean): Promise<Array<Course | InstructorCourseView>> {
    const courses = await this.findAllFresh();
    return instructorOnly ? courses.map((course) => this.toInstructorView(course)) : courses;
  }

  findOne(id: number): Course {
    const row = this.db.findById<StoredCourse>(COURSES, id);
    if (!row) throw new NotFoundException(`Course ${id} not found`);
    return this.effective(row);
  }

  async findOneFresh(id: number): Promise<Course> {
    await Promise.all([
      this.store.hydrate<StoredCourse>(COURSES_SPEC),
      this.profiles.hydrate(),
    ]);
    return this.findOne(id);
  }

  async findOneFreshForActor(id: number, instructorOnly: boolean): Promise<Course | InstructorCourseView> {
    const course = await this.findOneFresh(id);
    return instructorOnly ? this.toInstructorView(course) : course;
  }

  findOptional(id: number): Course | undefined {
    const row = this.db.findById<StoredCourse>(COURSES, id);
    return row ? this.effective(row) : undefined;
  }

  private toInstructorView(course: Course): InstructorCourseView {
    const safe: Partial<Course> = { ...course };
    delete safe.price;
    delete safe.hourlyRate;
    delete safe.hourlyRateOverride;
    return safe as InstructorCourseView;
  }

  /** 과목명 기반 composite 수업 개설이 인스턴스 간 같은 과목을 중복 생성하지 않도록 쓰는 안정 잠금 키. */
  subjectNameLockKey(subjectName: string): CalendarLockKey {
    const normalized = this.normalizeSubjectName(subjectName);
    const raw = createHash('sha256').update(normalized.toLocaleLowerCase('ko-KR')).digest().readUInt32BE(0);
    return { kind: 'subject', id: (raw & 0x7fffffff) || 1 };
  }

  /**
   * 사용자에게는 과목 하나로 보이지만 내부적으로 subject catalog와 instructor별 course 운영 단위를 보존한다.
   * 호출자가 더 큰 UoW 안에 있으면 nested transaction은 passthrough되어 session/enrollment와 원자 커밋된다.
   */
  async resolveSubjectCourse(input: {
    subjectName: string;
    instructorId: number | null;
    hourlyRateOverride?: number | null;
    coursePrice?: number;
    isKinder?: boolean;
    color?: string;
  }, actorId?: number): Promise<{ subject: Subject; course: Course }> {
    const requestedName = this.normalizeSubjectName(input.subjectName);
    return this.uow.run(async () => {
      await this.uow.lockTargets([
        this.subjectNameLockKey(requestedName),
        ...(input.instructorId == null ? [] : [{ kind: 'instructor' as const, id: input.instructorId }]),
      ]);
      await this.reloadCommandState();
      const profile = this.assertRefs({ instructorId: input.instructorId });

      let subject = this.db.findAll<Subject>(SUBJECTS).find(
        (row) => row.name.trim().toLocaleLowerCase('ko-KR') === requestedName.toLocaleLowerCase('ko-KR'),
      );
      if (!subject) {
        const digest = createHash('sha256').update(requestedName.toLocaleLowerCase('ko-KR')).digest('hex').slice(0, 14).toUpperCase();
        subject = await this.store.insert<Subject>(SUBJECTS_SPEC, {
          code: `AUTO_${digest}_${Date.now().toString(36).toUpperCase()}`,
          name: requestedName,
        });
        if (actorId != null) {
          await this.audit.log({
            entity: 'subjects',
            entityId: subject.id,
            action: 'create',
            actorId,
            changes: this.audit.snapshotOf(subject),
          });
        }
      }

      const stored = this.db.findBy<StoredCourse>(COURSES, (row) =>
        Number(row.subjectId) === Number(subject!.id) && row.instructorId === input.instructorId,
      )[0];
      if (!stored) {
        const course = await this.create({
          name: subject.name,
          subjectId: subject.id,
          instructorId: input.instructorId,
          price: input.coursePrice ?? 0,
          hourlyRateOverride: input.hourlyRateOverride ?? null,
          isKinder: input.isKinder ?? false,
          color: input.color,
        }, actorId);
        return { subject, course };
      }

      const nextOverride = input.hourlyRateOverride !== undefined ? input.hourlyRateOverride : stored.hourlyRateOverride ?? null;
      const effectiveRate = nextOverride ?? profile?.defaultHourlyRate ?? 0;
      if (input.instructorId != null && effectiveRate <= 0) throw new BadRequestException('강사 기본 시급 또는 수업 override를 1원 이상 설정해야 합니다.');
      // [TBO-61 2026-07-24] Kinder 가능 여부 게이트 제거(대표 지시 '유연하게') — 프로필 canTeachKinder는 정보 표시용으로만 유지.
      const patch = {
        name: subject.name,
        subjectId: subject.id,
        instructorId: input.instructorId,
        ...(input.coursePrice !== undefined ? { price: input.coursePrice } : {}),
        ...(input.hourlyRateOverride !== undefined ? { hourlyRateOverride: input.hourlyRateOverride } : {}),
        ...(input.isKinder !== undefined ? { isKinder: input.isKinder } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
      };
      const changed = Object.entries(patch).some(([key, value]) =>
        (stored as unknown as Record<string, unknown>)[key] !== value,
      );
      const course = changed ? await this.update(stored.id, patch, actorId) : this.effective(stored);
      return { subject, course };
    });
  }

  // actorId 없으면(시드·내부 경로) audit 생략. 쓰기+audit 한 tx(uow).
  async create(dto: CreateCourseDto, actorId?: number): Promise<Course> {
    return this.uow.run(async () => {
      await this.uow.lockTargets([
        ...(dto.subjectId != null ? [{ kind: 'subject' as const, id: dto.subjectId }] : []),
        ...(dto.instructorId != null ? [{ kind: 'user' as const, id: dto.instructorId }] : []),
      ]);
      await this.reloadCommandState();
      const profile = this.assertRefs(dto);
      const explicitOverride = dto.hourlyRateOverride !== undefined
        ? dto.hourlyRateOverride
        : dto.hourlyRate !== undefined ? dto.hourlyRate : null;
      const effectiveRate = explicitOverride ?? profile?.defaultHourlyRate ?? 0;
      if (dto.instructorId != null && effectiveRate <= 0) throw new BadRequestException('강사 기본 시급 또는 수업 override를 1원 이상 설정해야 합니다.');
      // [TBO-61 2026-07-24] Kinder 가능 여부 게이트 제거(대표 지시 '유연하게') — 프로필 canTeachKinder는 정보 표시용으로만 유지.
      const row = await this.store.insert<StoredCourse>(COURSES_SPEC, {
        name: dto.name,
        subjectId: dto.subjectId,
        instructorId: dto.instructorId ?? null,
        price: dto.price,
        hourlyRateOverride: explicitOverride,
        isKinder: dto.isKinder ?? false,
        color: dto.color,
      });
      // [감사 전수 2026-07-16] 전 테이블 CRUD 이력(대표 지시)
      if (actorId != null) await this.audit.log({ entity: 'courses', entityId: row.id, action: 'create', actorId,
        changes: this.audit.snapshotOf(this.effective(row)) });
      return this.effective(row);
    });
  }

  async update(id: number, dto: UpdateCourseDto, actorId?: number): Promise<Course> {
    return this.uow.run(async () => {
      await this.uow.lockTargets([
        { kind: 'course', id },
        ...(dto.subjectId != null ? [{ kind: 'subject' as const, id: dto.subjectId }] : []),
        ...(dto.instructorId != null ? [{ kind: 'user' as const, id: dto.instructorId }] : []),
      ]);
      await this.reloadCommandState();
      const current = this.db.findById<StoredCourse>(COURSES, id);
      if (!current) throw new NotFoundException(`Course ${id} not found`);
      const before = this.effective(current);
      const instructorId = dto.instructorId === undefined ? current.instructorId : dto.instructorId;
      const profile = this.assertRefs({ ...dto, instructorId });
      const explicitOverride = dto.hourlyRateOverride !== undefined
        ? dto.hourlyRateOverride
        : dto.hourlyRate !== undefined ? dto.hourlyRate : current.hourlyRateOverride ?? null;
      const profileRate = profile?.defaultHourlyRate ?? 0;
      const effectiveRate = explicitOverride ?? profileRate;
      const isKinder = dto.isKinder ?? current.isKinder;
      if (instructorId != null && effectiveRate <= 0) throw new BadRequestException('강사 기본 시급 또는 수업 override를 1원 이상 설정해야 합니다.');
      // [TBO-61 2026-07-24] Kinder 가능 여부 게이트 제거(대표 지시 '유연하게') — 프로필 canTeachKinder는 정보 표시용으로만 유지.
      const { hourlyRate: _legacyInput, ...fields } = dto;
      void _legacyInput;
      const stored = await this.store.update<StoredCourse>(COURSES_SPEC, id, {
        ...fields,
        hourlyRateOverride: explicitOverride,
        isKinder,
      }) as StoredCourse;
      const after = this.effective(stored);
      if (actorId != null) {
        await this.audit.log({ entity: 'courses', entityId: id, action: 'update', actorId, changes: this.audit.diffOf(before, after) });
      }
      return after;
    });
  }

  async remove(id: number, actorId?: number): Promise<Course> {
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'course', id }]);
      await this.reloadCommandState();
      const before = { ...this.findOne(id) };
      const [enrollment, interest] = await Promise.all([
        this.store.findActive<Enrollment>(ENROLLMENTS_SPEC, { where: { courseId: id }, limit: 1 }),
        this.store.findActive<StudentInterest>(STUDENT_INTERESTS_SPEC, { where: { courseId: id }, limit: 1 }),
      ]);
      const hasSession = await this.sessions.existsForCourse(id);
      const roadmap = this.db.findBy<RoadmapCourse>(ROADMAP_COURSES, (row) => row.courseId === id)[0];
      const blockers = [enrollment.length && '수강', hasSession && '수업', interest.length && '학생 희망 수업', roadmap && '로드맵'].filter(Boolean);
      if (blockers.length) throw new ConflictException(`참조 중인 코스는 삭제할 수 없습니다: ${blockers.join('·')}`);
      await this.store.remove(COURSES_SPEC, id, actorId);
      if (actorId != null) {
        await this.audit.log({ entity: 'courses', entityId: id, action: 'delete', actorId, changes: this.audit.snapshotOf(before) });
      }
      return before;
    });
  }

  /** 수업 C/U/D의 FK·단가·Kinder·삭제 blocker 판단을 transaction 안의 Postgres readback으로 고정한다. */
  private async reloadCommandState(): Promise<void> {
    await this.store.hydrate<StoredCourse>(COURSES_SPEC);
    await this.store.hydrate<Subject>(SUBJECTS_SPEC);
    await this.store.hydrate<StaffAccount>(USERS_SPEC);
    await this.profiles.hydrate();
    await this.store.hydrate<RoadmapCourse>(ROADMAP_COURSES_SPEC);
  }

  private normalizeSubjectName(value: string): string {
    const normalized = value.trim().replace(/\s+/g, ' ');
    if (!normalized) throw new BadRequestException('과목명을 입력해 주세요.');
    if (normalized.length > 50) throw new BadRequestException('과목명은 50자 이하여야 합니다.');
    return normalized;
  }

  private assertRefs(dto: { subjectId?: number; instructorId?: number | null }) {
    if (dto.subjectId != null && !this.db.findById<Subject>(SUBJECTS, dto.subjectId)) {
      throw new BadRequestException(`subjectId ${dto.subjectId} 없음`);
    }
    if (dto.instructorId != null) {
      const account = this.db.findById<StaffAccount>(USERS, dto.instructorId);
      if (!isActiveInstructor(account)) throw new BadRequestException(`instructorId ${dto.instructorId}는 활성 강사가 아닙니다`);
      const profile = this.profiles.findActive(dto.instructorId);
      if (!profile) throw new BadRequestException(`instructorId ${dto.instructorId} 강사 프로필이 없습니다`);
      return profile;
    }
    return undefined;
  }

  private effective(course: StoredCourse): Course {
    return withEffectiveCourseRate(
      course,
      course.instructorId == null ? undefined : this.profiles.findActive(course.instructorId),
    );
  }

  /** 회차 실제 담당자 기준 유효 시급. 코스 override가 있으면 우선하고, 없으면 실제 강사 프로필을 쓴다. */
  effectiveHourlyRateFor(courseId: number, instructorId: number | null): number | undefined {
    if (instructorId == null) return undefined;
    const course = this.db.findById<StoredCourse>(COURSES, courseId);
    if (!course) return undefined;
    return course.hourlyRateOverride ?? this.profiles.findActive(instructorId)?.defaultHourlyRate;
  }
}
