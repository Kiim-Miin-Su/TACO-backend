import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { COUNSEL_FORMS_SPEC, COURSES_SPEC, ENROLLMENTS_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { ClassSessionsStore } from '../schedule/class-sessions.store';
import { AuditService } from '../audit/audit.service';
import { Subject, SUBJECTS } from '../subjects/subject.entity';
import { StaffAccount, USERS, isActiveInstructor } from '../users/user.entity';
import { Enrollment } from '../enrollments/enrollment.entity';
import { CounselForm } from '../counsel/counsel.entity';
import { ROADMAP_COURSES, RoadmapCourse } from '../roadmaps/roadmap.entity';
import { Course, COURSES } from './course.entity';
import { CreateCourseDto } from './dto/create-course.dto';
import { UpdateCourseDto } from './dto/update-course.dto';
import { InstructorProfilesStore } from '../users/instructor-profiles.store';
import { withEffectiveCourseRate } from './course-pay.resolver';

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

  // 데모 코스 시드 — 스케줄 모듈 COURSES(10,11,12)와 id·강사·과목·색 정렬.
  // hourlyRate(시급)는 페이 산정의 기준값으로, class_sessions.courseId → courses.id
  // 조인의 단일 소스. 세션이 참조하는 코스 id를 고정해 FK/조인 무결성을 보장한다.
  async onModuleInit(): Promise<void> {
    const hydrated = await this.store.hydrate<Course>(COURSES_SPEC);
    if (hydrated.length) return;
    await this.store.seed<Course>(COURSES_SPEC, [
      // 정가(price)는 결제 시드 금액과 정합(코스10=480,000 등) — 단일 소스 일관성.
      { id: 10, name: 'SAT Reading 정규', subjectId: 1, instructorId: 1, price: 480000, hourlyRate: 50000, hourlyRateOverride: null, isKinder: false, color: '#0969da' },
      { id: 11, name: 'AP Calculus BC', subjectId: 2, instructorId: 2, price: 520000, hourlyRate: 60000, hourlyRateOverride: null, isKinder: false, color: '#8250df' },
      { id: 12, name: 'TOEFL 정규', subjectId: 1, instructorId: 1, price: 420000, hourlyRate: 45000, hourlyRateOverride: null, isKinder: false, color: '#1b7c83' },
    ]);
  }

  findAll(): Course[] {
    return this.db.findAll<Course>(COURSES).map((course) => this.effective(course));
  }

  findOne(id: number): Course {
    const row = this.db.findById<Course>(COURSES, id);
    if (!row) throw new NotFoundException(`Course ${id} not found`);
    return this.effective(row);
  }

  findOptional(id: number): Course | undefined {
    const row = this.db.findById<Course>(COURSES, id);
    return row ? this.effective(row) : undefined;
  }

  // actorId 없으면(시드·내부 경로) audit 생략. 쓰기+audit 한 tx(uow).
  async create(dto: CreateCourseDto, actorId?: number): Promise<Course> {
    const profile = this.assertRefs(dto);
    const explicitOverride = dto.hourlyRateOverride !== undefined
      ? dto.hourlyRateOverride
      : dto.hourlyRate !== undefined ? dto.hourlyRate : null;
    const effectiveRate = explicitOverride ?? profile?.defaultHourlyRate ?? 0;
    if (effectiveRate <= 0) throw new BadRequestException('강사 기본 시급 또는 수업 override를 1원 이상 설정해야 합니다.');
    if (dto.isKinder && !profile!.canTeachKinder) throw new BadRequestException('Kinder 수업이 불가능한 강사입니다.');
    return this.uow.run(async () => {
      const row = await this.store.insert<Course>(COURSES_SPEC, {
        name: dto.name,
        subjectId: dto.subjectId,
        instructorId: dto.instructorId,
        price: dto.price,
        hourlyRate: effectiveRate,
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
    const current = this.db.findById<Course>(COURSES, id);
    if (!current) throw new NotFoundException(`Course ${id} not found`);
    const before = this.effective(current);
    const instructorId = dto.instructorId ?? current.instructorId;
    const profile = this.assertRefs({ ...dto, instructorId });
    const explicitOverride = dto.hourlyRateOverride !== undefined
      ? dto.hourlyRateOverride
      : dto.hourlyRate !== undefined ? dto.hourlyRate : current.hourlyRateOverride ?? null;
    const legacyFallback = current.hourlyRate;
    const profileRate = profile?.defaultHourlyRate ?? 0;
    const effectiveRate = explicitOverride ?? (profileRate > 0 ? profileRate : legacyFallback);
    const isKinder = dto.isKinder ?? current.isKinder;
    if (effectiveRate <= 0) throw new BadRequestException('강사 기본 시급 또는 수업 override를 1원 이상 설정해야 합니다.');
    if (isKinder && !profile!.canTeachKinder) throw new BadRequestException('Kinder 수업이 불가능한 강사입니다.');
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'course', id }]);
      const { hourlyRate: _legacyInput, ...fields } = dto;
      void _legacyInput;
      const stored = await this.store.update<Course>(COURSES_SPEC, id, {
        ...fields,
        hourlyRate: effectiveRate,
        hourlyRateOverride: explicitOverride,
        isKinder,
      }) as Course;
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
      const before = { ...this.findOne(id) };
      const [enrollment, counsel] = await Promise.all([
        this.store.findActive<Enrollment>(ENROLLMENTS_SPEC, { where: { courseId: id }, limit: 1 }),
        this.store.findActive<CounselForm>(COUNSEL_FORMS_SPEC, { where: { interestCourseId: id }, limit: 1 }),
      ]);
      const hasSession = await this.sessions.existsForCourse(id);
      const roadmap = this.db.findBy<RoadmapCourse>(ROADMAP_COURSES, (row) => row.courseId === id)[0];
      const blockers = [enrollment.length && '수강', hasSession && '수업', counsel.length && '상담', roadmap && '로드맵'].filter(Boolean);
      if (blockers.length) throw new ConflictException(`참조 중인 코스는 삭제할 수 없습니다: ${blockers.join('·')}`);
      await this.store.remove(COURSES_SPEC, id, actorId);
      if (actorId != null) {
        await this.audit.log({ entity: 'courses', entityId: id, action: 'delete', actorId, changes: this.audit.snapshotOf(before) });
      }
      return before;
    });
  }

  private assertRefs(dto: { subjectId?: number; instructorId?: number }) {
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

  private effective(course: Course): Course {
    return withEffectiveCourseRate(course, this.profiles.findActive(course.instructorId));
  }
}
