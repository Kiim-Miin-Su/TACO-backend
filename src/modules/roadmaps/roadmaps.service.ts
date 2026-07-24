import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { COURSES_SPEC as COURSES_SPEC_REF, ROADMAPS_SPEC, ROADMAP_COURSES_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { AuditService } from '../audit/audit.service';
import { Roadmap, RoadmapCourse, ROADMAPS, ROADMAP_COURSES } from './roadmap.entity';
import { Course, COURSES } from '../courses/course.entity';
import { CreateRoadmapDto, UpdateRoadmapDto } from './dto/roadmap.dto';

export type RoadmapAggregate = Roadmap & {
  /** sortOrder 정렬된 연결 코스(조인 파생 — 코스 원부는 courses SSOT). */
  courses: Array<{ linkId: number; courseId: number; sortOrder: number; courseName: string; subjectId: number }>;
};

/**
 * [TBO-47 2026-07-23 대표 지시 "서비스 실 구현"] 수강 로드맵 — 마지막 dormant 도메인 실구현.
 *  로드맵 = 코스 묶음 카탈로그(순서 보존 M:N). 표·계약·활성 unique는 TBO-33이 이미 영속화 —
 *  이 서비스가 hydrate 갭(roadmaps 미수화)을 해소하고 CRUD·연결·재정렬을 제공한다.
 *  규약: 쓰기 전부 uow.run+lock+audit(전 테이블 이력) · 코스 원부는 courses SSOT(사본 저장 0).
 */
@Injectable()
export class RoadmapsService implements OnModuleInit {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
    private readonly uow: CalendarUnitOfWork,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.store.hydrate<Roadmap>(ROADMAPS_SPEC); // dormant 갭 해소 — 종전엔 이 표만 미수화
    await this.store.hydrate<RoadmapCourse>(ROADMAP_COURSES_SPEC);
  }

  private courseOrThrow(courseId: number): Course {
    const course = this.db.findById<Course>(COURSES, courseId);
    if (!course) throw new BadRequestException(`courseId ${courseId} 없음(존재하지 않는 코스)`);
    return course;
  }

  private linksOf(roadmapId: number): RoadmapCourse[] {
    return this.db.findByField<RoadmapCourse>(ROADMAP_COURSES, 'roadmapId', roadmapId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  }

  private toAggregate(roadmap: Roadmap): RoadmapAggregate {
    const courses = this.linksOf(roadmap.id).map((link) => {
      const course = this.db.findById<Course>(COURSES, link.courseId);
      return {
        linkId: link.id, courseId: link.courseId, sortOrder: link.sortOrder,
        courseName: course?.name ?? `코스 #${link.courseId}`, subjectId: course?.subjectId ?? 0,
      };
    });
    return { ...roadmap, courses };
  }

  findAll(): RoadmapAggregate[] {
    return this.db.findAll<Roadmap>(ROADMAPS)
      .sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.id - b.id)
      .map((roadmap) => this.toAggregate(roadmap));
  }

  /** [TBO-54 C2] 목록/단건 READ = DB 권위 — 로드맵·링크·코스명 조인을 전부 findActive로 조립. */
  async listDb(): Promise<RoadmapAggregate[]> {
    const [roadmaps, links, courses] = await Promise.all([
      this.store.findActive<Roadmap>(ROADMAPS_SPEC),
      this.store.findActive<RoadmapCourse>(ROADMAP_COURSES_SPEC),
      this.store.findActive<Course>(COURSES_SPEC_REF),
    ]);
    const courseById = new Map(courses.map((course) => [course.id, course]));
    const aggregate = (roadmap: Roadmap): RoadmapAggregate => ({
      ...roadmap,
      courses: links.filter((link) => link.roadmapId === roadmap.id)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
        .map((link) => {
          const course = courseById.get(link.courseId);
          return {
            linkId: link.id, courseId: link.courseId, sortOrder: link.sortOrder,
            courseName: course?.name ?? `코스 #${link.courseId}`, subjectId: course?.subjectId ?? 0,
          };
        }),
    });
    return roadmaps
      .sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.id - b.id)
      .map(aggregate);
  }

  async getDb(id: number): Promise<RoadmapAggregate> {
    const row = (await this.listDb()).find((roadmap) => roadmap.id === id);
    if (!row) throw new NotFoundException(`Roadmap ${id} not found`);
    return row;
  }

  findOne(id: number): RoadmapAggregate {
    const roadmap = this.db.findById<Roadmap>(ROADMAPS, id);
    if (!roadmap) throw new NotFoundException(`Roadmap ${id} not found`);
    return this.toAggregate(roadmap);
  }

  // 생성 — courseIds가 있으면 순서대로 연결까지 한 tx(부분 생성 잔존 금지).
  async create(dto: CreateRoadmapDto, actorId?: number): Promise<RoadmapAggregate> {
    const courseIds = dto.courseIds ?? [];
    if (new Set(courseIds).size !== courseIds.length) throw new BadRequestException('courseIds에 중복이 있습니다.');
    courseIds.forEach((courseId) => this.courseOrThrow(courseId));
    return this.uow.run(async () => {
      const roadmap = await this.store.insert<Roadmap>(ROADMAPS_SPEC, {
        title: dto.title.trim(),
        description: dto.description?.trim() || null,
        targetGrade: dto.targetGrade ?? null,
        durationWeeks: dto.durationWeeks ?? null,
        isActive: true,
      } as unknown as Omit<Roadmap, 'id' | 'createdAt' | 'updatedAt'>);
      for (let index = 0; index < courseIds.length; index += 1) {
        await this.store.insert<RoadmapCourse>(ROADMAP_COURSES_SPEC, {
          roadmapId: roadmap.id, courseId: courseIds[index], sortOrder: index,
        } as Omit<RoadmapCourse, 'id' | 'createdAt' | 'updatedAt'>);
      }
      if (actorId != null) {
        await this.audit.log({
          entity: ROADMAPS, entityId: roadmap.id, action: 'create', actorId,
          changes: this.audit.diffOf({}, { ...roadmap, courseIds }),
        });
      }
      return this.findOne(roadmap.id);
    });
  }

  async update(id: number, dto: UpdateRoadmapDto, actorId?: number): Promise<RoadmapAggregate> {
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'roadmap', id }]);
      const before = { ...this.findOne(id) };
      const patch: Partial<Roadmap> = {
        ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
        ...(dto.description !== undefined ? { description: dto.description?.trim() || null } : {}),
        ...(dto.targetGrade !== undefined ? { targetGrade: dto.targetGrade } : {}),
        ...(dto.durationWeeks !== undefined ? { durationWeeks: dto.durationWeeks } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      } as Partial<Roadmap>;
      const after = await this.store.update<Roadmap>(ROADMAPS_SPEC, id, patch);
      if (!after) throw new NotFoundException(`Roadmap ${id} not found`);
      if (actorId != null) {
        await this.audit.log({
          entity: ROADMAPS, entityId: id, action: 'update', actorId,
          changes: this.audit.diffOf(before, after),
        });
      }
      return this.findOne(id);
    });
  }

  // soft delete — 연결 코스 링크도 같은 tx에서 캐스케이드(고아 링크·재노출 방지).
  async remove(id: number, actorId: number): Promise<{ id: number; deleted: true }> {
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'roadmap', id }]);
      const before = this.findOne(id);
      for (const link of this.linksOf(id)) {
        await this.store.remove(ROADMAP_COURSES_SPEC, link.id, actorId);
      }
      await this.store.remove(ROADMAPS_SPEC, id, actorId);
      await this.audit.log({
        entity: ROADMAPS, entityId: id, action: 'delete', actorId,
        changes: this.audit.snapshotOf(before), reason: `cascade-links:${before.courses.length}`,
      });
      return { id, deleted: true };
    });
  }

  async addCourse(roadmapId: number, courseId: number, actorId: number): Promise<RoadmapAggregate> {
    this.courseOrThrow(courseId);
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'roadmap', id: roadmapId }]);
      this.findOne(roadmapId);
      const duplicate = this.linksOf(roadmapId).some((link) => link.courseId === courseId);
      if (duplicate) throw new ConflictException('이미 이 로드맵에 연결된 코스입니다.');
      const nextOrder = this.linksOf(roadmapId).reduce((max, link) => Math.max(max, link.sortOrder), -1) + 1;
      const link = await this.store.insert<RoadmapCourse>(ROADMAP_COURSES_SPEC, {
        roadmapId, courseId, sortOrder: nextOrder,
      } as Omit<RoadmapCourse, 'id' | 'createdAt' | 'updatedAt'>);
      await this.audit.log({
        entity: ROADMAP_COURSES, entityId: link.id, action: 'create', actorId,
        changes: this.audit.diffOf({}, link),
      });
      return this.findOne(roadmapId);
    });
  }

  async removeCourse(roadmapId: number, courseId: number, actorId: number): Promise<RoadmapAggregate> {
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'roadmap', id: roadmapId }]);
      this.findOne(roadmapId);
      const link = this.linksOf(roadmapId).find((row) => row.courseId === courseId);
      if (!link) throw new NotFoundException(`로드맵 ${roadmapId}에 코스 ${courseId} 연결 없음`);
      await this.store.remove(ROADMAP_COURSES_SPEC, link.id, actorId);
      await this.audit.log({
        entity: ROADMAP_COURSES, entityId: link.id, action: 'delete', actorId,
        changes: this.audit.snapshotOf(link),
      });
      // 잔여 링크 sortOrder 연속 재정렬(구멍 방지 — 결정론 순서 유지)
      const remaining = this.linksOf(roadmapId);
      for (let index = 0; index < remaining.length; index += 1) {
        if (remaining[index].sortOrder !== index) {
          await this.store.update<RoadmapCourse>(ROADMAP_COURSES_SPEC, remaining[index].id, { sortOrder: index });
        }
      }
      return this.findOne(roadmapId);
    });
  }

  // 전체 순서 교체 — 부분 목록·이물 courseId는 400(조용한 누락 금지).
  async reorderCourses(roadmapId: number, courseIds: number[], actorId: number): Promise<RoadmapAggregate> {
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'roadmap', id: roadmapId }]);
      this.findOne(roadmapId);
      const links = this.linksOf(roadmapId);
      const current = links.map((link) => link.courseId).sort((a, b) => a - b);
      const requested = [...courseIds].sort((a, b) => a - b);
      if (current.length !== requested.length || current.some((value, index) => value !== requested[index])) {
        throw new BadRequestException('courseIds는 로드맵의 전체 코스와 정확히 일치해야 합니다(부분 재정렬 금지).');
      }
      const before = links.map((link) => ({ courseId: link.courseId, sortOrder: link.sortOrder }));
      for (const link of links) {
        const nextOrder = courseIds.indexOf(link.courseId);
        if (link.sortOrder !== nextOrder) {
          await this.store.update<RoadmapCourse>(ROADMAP_COURSES_SPEC, link.id, { sortOrder: nextOrder });
        }
      }
      await this.audit.log({
        entity: ROADMAPS, entityId: roadmapId, action: 'update', actorId,
        changes: this.audit.diffOf({ order: before }, { order: courseIds.map((courseId, sortOrder) => ({ courseId, sortOrder })) }),
        reason: 'reorder-courses',
      });
      return this.findOne(roadmapId);
    });
  }
}
