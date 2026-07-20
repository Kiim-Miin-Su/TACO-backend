import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { AuditService } from '../audit/audit.service';
import { Course, COURSES } from '../courses/course.entity';
import { Roadmap, RoadmapCourse, ROADMAPS, ROADMAP_COURSES } from './roadmap.entity';
import { CreateRoadmapDto } from './dto/create-roadmap.dto';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { ROADMAPS_SPEC, ROADMAP_COURSES_SPEC } from '../../database/calendar-asset-specs';

/**
 * [참조/처리] 로드맵(코스 묶음) + roadmap↔course M:N 조인.
 *  - 시드: 로드맵 1(SAT 종합) + 링크 2(course 10·12) — 프론트 목데이터·courses 시드와 정합.
 *  - create: courseIds 각각을 courses에서 존재 검증(없으면 400) 후 로드맵 + 링크(sortOrder=순서) 생성.
 *    입력 중복은 DTO ArrayUnique로 차단 → (roadmap,course) 유니크 보장.
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
    await this.store.hydrate<Roadmap>(ROADMAPS_SPEC);
    await this.store.hydrate<RoadmapCourse>(ROADMAP_COURSES_SPEC);
    if (!this.db.findById<Course>(COURSES, 10) || !this.db.findById<Course>(COURSES, 12)) return;
    await this.store.seed<Roadmap>(ROADMAPS_SPEC, [
      { id: 1, title: 'SAT 종합 로드맵', description: 'Reading→TOEFL 병행 코스 묶음', targetGrade: 11, durationWeeks: 24, isActive: true },
    ]);
    await this.store.seed<RoadmapCourse>(ROADMAP_COURSES_SPEC, [
      { id: 1, roadmapId: 1, courseId: 10, sortOrder: 0 },
      { id: 2, roadmapId: 1, courseId: 12, sortOrder: 1 },
    ]);
  }

  findAll(): Roadmap[] {
    return this.db.findAll<Roadmap>(ROADMAPS);
  }

  findAllCourses(): RoadmapCourse[] {
    return this.db.findAll<RoadmapCourse>(ROADMAP_COURSES);
  }

  // actorId 없으면(시드·내부 경로) audit 생략.
  async create(dto: CreateRoadmapDto, actorId?: number): Promise<Roadmap> {
    const courseIds = dto.courseIds ?? [];
    // 코스 FK 검증 — 하나라도 없으면 링크를 만들지 않고 400(부분 생성 방지).
    for (const courseId of courseIds) {
      if (!this.db.findById<Course>(COURSES, courseId))
        throw new BadRequestException(`courseId ${courseId} 없음(존재하지 않는 코스)`);
    }
    // [무결성 2026-07-07] 로드맵 + 코스 링크 다중 insert 원자성 — 중간 실패 시 roadmap만 남아 링크 누락되던
    //  부분 생성 위험 제거(db write-path 감사 지적). 단일 tx로 함께 반영/롤백.
    return this.uow.run(async () => {
      const roadmap = await this.store.insert<Roadmap>(ROADMAPS_SPEC, {
        title: dto.title,
        description: dto.description,
        targetGrade: dto.targetGrade,
        isActive: true,
      });
      // [감사 전수 2026-07-16] 전 테이블 CRUD 이력(대표 지시) — 기존 db.transaction 안에 audit만 추가.
      if (actorId != null) await this.audit.log({ entity: 'roadmaps', entityId: roadmap.id, action: 'create', actorId });
      for (const [i, courseId] of courseIds.entries()) {
        const link = await this.store.insert<RoadmapCourse>(ROADMAP_COURSES_SPEC, { roadmapId: roadmap.id, courseId, sortOrder: i });
        // [감사 전수 2026-07-16] 전 테이블 CRUD 이력(대표 지시) — 링크 행별 audit(두 테이블 각각).
        if (actorId != null) await this.audit.log({ entity: 'roadmap_courses', entityId: link.id, action: 'create', actorId });
      }
      return roadmap;
    });
  }
}
