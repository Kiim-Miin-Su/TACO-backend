import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import {
  COURSES_SPEC as COURSES_SPEC_REF,
  ENROLLMENTS_SPEC,
  ROADMAPS_SPEC,
  ROADMAP_COURSES_SPEC,
} from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { AuditService } from '../audit/audit.service';
import { Roadmap, RoadmapCourse, ROADMAPS, ROADMAP_COURSES } from './roadmap.entity';
import { Course } from '../courses/course.entity';
import { CreateRoadmapDto, UpdateRoadmapDto } from './dto/roadmap.dto';
import type { Enrollment } from '../enrollments/enrollment.entity';

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
  // [TBO-56 C2b] InMemoryDatabase 주입 제거 — 읽기(listDb/getDb)·명령 판정 전부 DB 권위.
  constructor(
    private readonly store: PostgresCollectionStore,
    private readonly uow: CalendarUnitOfWork,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.store.hydrate<Roadmap>(ROADMAPS_SPEC); // dormant 갭 해소 — 종전엔 이 표만 미수화
    await this.store.hydrate<RoadmapCourse>(ROADMAP_COURSES_SPEC);
  }

  // [TBO-56 C2b] 명령 경로 참조 판정 = DB 기준(findActive) — 메모리 미러 stale로
  //  삭제된 코스 연결·유령 로드맵 수정이 통과하는 경로 차단. (읽기 조립은 listDb가 담당)
  private async courseInDbOrThrow(courseId: number): Promise<Course> {
    const [course] = await this.store.findActive<Course>(COURSES_SPEC_REF, { where: { id: courseId } as Partial<Course>, limit: 1 });
    if (!course) throw new BadRequestException(`courseId ${courseId} 없음(존재하지 않는 코스)`);
    return course;
  }

  private async roadmapInDbOrThrow(id: number): Promise<Roadmap> {
    const [roadmap] = await this.store.findActive<Roadmap>(ROADMAPS_SPEC, { where: { id } as Partial<Roadmap>, limit: 1 });
    if (!roadmap) throw new NotFoundException(`Roadmap ${id} not found`);
    return roadmap;
  }

  private async linksOfDb(roadmapId: number): Promise<RoadmapCourse[]> {
    const links = await this.store.findActive<RoadmapCourse>(ROADMAP_COURSES_SPEC, { where: { roadmapId } as Partial<RoadmapCourse> });
    return links.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  }

  private async enrollmentRefsDb(
    roadmapId: number,
    courseId?: number,
    activeLifecycleOnly = false,
  ): Promise<Enrollment[]> {
    const rows = await this.store.findActive<Enrollment>(ENROLLMENTS_SPEC, {
      where: {
        roadmapId,
        ...(courseId == null ? {} : { courseId }),
      } as Partial<Enrollment>,
    });
    return activeLifecycleOnly ? rows.filter((row) => row.status === 'active') : rows;
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

  // 생성 — courseIds가 있으면 순서대로 연결까지 한 tx(부분 생성 잔존 금지).
  async create(dto: CreateRoadmapDto, actorId?: number): Promise<RoadmapAggregate> {
    const courseIds = dto.courseIds ?? [];
    if (new Set(courseIds).size !== courseIds.length) throw new BadRequestException('courseIds에 중복이 있습니다.');
    return this.uow.run(async () => {
      // [TBO-56 C2b] 코스 존재 판정 = 같은 tx 안 DB 기준(삭제된 코스 연결 차단)
      for (const courseId of courseIds) await this.courseInDbOrThrow(courseId);
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
      return this.getDb(roadmap.id); // [TBO-56 C2b] 응답도 DB 조립(쓰기 직후 재조회)
    });
  }

  async update(id: number, dto: UpdateRoadmapDto, actorId?: number): Promise<RoadmapAggregate> {
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'roadmap', id }]);
      const before = await this.getDb(id); // [TBO-56 C2b] before = lock 후 DB 재조회(diff 정확성)
      if (dto.isActive === false && before.isActive === true) {
        const activeRefs = await this.enrollmentRefsDb(id, undefined, true);
        if (activeRefs.length) {
          throw new ConflictException(
            `활성 수강 ${activeRefs.length}건이 연결되어 로드맵을 비활성화할 수 없습니다.`,
          );
        }
      }
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
      return this.getDb(id);
    });
  }

  // soft delete — 연결 코스 링크도 같은 tx에서 캐스케이드(고아 링크·재노출 방지).
  async remove(id: number, actorId: number): Promise<{ id: number; deleted: true }> {
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'roadmap', id }]);
      const before = await this.getDb(id); // [TBO-56 C2b] 스냅샷·캐스케이드 대상 = lock 후 DB 기준
      const enrollmentRefs = await this.enrollmentRefsDb(id);
      if (enrollmentRefs.length) {
        throw new ConflictException(
          `수강 이력 ${enrollmentRefs.length}건이 연결되어 로드맵을 삭제할 수 없습니다. 비활성화를 사용하세요.`,
        );
      }
      for (const link of await this.linksOfDb(id)) {
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
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'roadmap', id: roadmapId }]);
      // [TBO-56 C2b] 존재·중복·다음 순번 전부 lock 후 DB 기준(stale 미러로 중복 통과 차단)
      await this.roadmapInDbOrThrow(roadmapId);
      await this.courseInDbOrThrow(courseId);
      const links = await this.linksOfDb(roadmapId);
      if (links.some((link) => link.courseId === courseId)) throw new ConflictException('이미 이 로드맵에 연결된 코스입니다.');
      const nextOrder = links.reduce((max, link) => Math.max(max, link.sortOrder), -1) + 1;
      const link = await this.store.insert<RoadmapCourse>(ROADMAP_COURSES_SPEC, {
        roadmapId, courseId, sortOrder: nextOrder,
      } as Omit<RoadmapCourse, 'id' | 'createdAt' | 'updatedAt'>);
      await this.audit.log({
        entity: ROADMAP_COURSES, entityId: link.id, action: 'create', actorId,
        changes: this.audit.diffOf({}, link),
      });
      return this.getDb(roadmapId);
    });
  }

  async removeCourse(roadmapId: number, courseId: number, actorId: number): Promise<RoadmapAggregate> {
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'roadmap', id: roadmapId }]);
      await this.roadmapInDbOrThrow(roadmapId); // [TBO-56 C2b] lock 후 DB 기준
      const link = (await this.linksOfDb(roadmapId)).find((row) => row.courseId === courseId);
      if (!link) throw new NotFoundException(`로드맵 ${roadmapId}에 코스 ${courseId} 연결 없음`);
      const enrollmentRefs = await this.enrollmentRefsDb(roadmapId, courseId);
      if (enrollmentRefs.length) {
        throw new ConflictException(
          `수강 이력 ${enrollmentRefs.length}건이 연결되어 이 코스를 로드맵에서 해제할 수 없습니다.`,
        );
      }
      await this.store.remove(ROADMAP_COURSES_SPEC, link.id, actorId);
      await this.audit.log({
        entity: ROADMAP_COURSES, entityId: link.id, action: 'delete', actorId,
        changes: this.audit.snapshotOf(link),
      });
      // 잔여 링크 sortOrder 연속 재정렬(구멍 방지 — 결정론 순서 유지) — 삭제 반영된 DB 기준
      const remaining = await this.linksOfDb(roadmapId);
      for (let index = 0; index < remaining.length; index += 1) {
        if (remaining[index].sortOrder !== index) {
          await this.store.update<RoadmapCourse>(ROADMAP_COURSES_SPEC, remaining[index].id, { sortOrder: index });
        }
      }
      return this.getDb(roadmapId);
    });
  }

  // 전체 순서 교체 — 부분 목록·이물 courseId는 400(조용한 누락 금지).
  async reorderCourses(roadmapId: number, courseIds: number[], actorId: number): Promise<RoadmapAggregate> {
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'roadmap', id: roadmapId }]);
      await this.roadmapInDbOrThrow(roadmapId); // [TBO-56 C2b] lock 후 DB 기준
      const links = await this.linksOfDb(roadmapId);
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
      return this.getDb(roadmapId);
    });
  }
}
