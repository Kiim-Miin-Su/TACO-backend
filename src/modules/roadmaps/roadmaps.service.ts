import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { Course, COURSES } from '../courses/course.entity';
import { Roadmap, RoadmapCourse, ROADMAPS, ROADMAP_COURSES } from './roadmap.entity';
import { CreateRoadmapDto } from './dto/create-roadmap.dto';

/**
 * [참조/처리] 로드맵(코스 묶음) + roadmap↔course M:N 조인.
 *  - 시드: 로드맵 1(SAT 종합) + 링크 2(course 10·12) — 프론트 목데이터·courses 시드와 정합.
 *  - create: courseIds 각각을 courses에서 존재 검증(없으면 400) 후 로드맵 + 링크(sortOrder=순서) 생성.
 *    입력 중복은 DTO ArrayUnique로 차단 → (roadmap,course) 유니크 보장.
 */
@Injectable()
export class RoadmapsService implements OnModuleInit {
  constructor(private readonly db: InMemoryDatabase) {}

  onModuleInit(): void {
    this.db.seed<Roadmap>(ROADMAPS, [
      { id: 1, title: 'SAT 종합 로드맵', description: 'Reading→TOEFL 병행 코스 묶음', targetGrade: 11, durationWeeks: 24, isActive: true },
    ]);
    this.db.seed<RoadmapCourse>(ROADMAP_COURSES, [
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

  create(dto: CreateRoadmapDto): Roadmap {
    const courseIds = dto.courseIds ?? [];
    // 코스 FK 검증 — 하나라도 없으면 링크를 만들지 않고 400(부분 생성 방지).
    for (const courseId of courseIds) {
      if (!this.db.findById<Course>(COURSES, courseId))
        throw new BadRequestException(`courseId ${courseId} 없음(존재하지 않는 코스)`);
    }
    const roadmap = this.db.insert<Roadmap>(ROADMAPS, {
      title: dto.title,
      description: dto.description,
      targetGrade: dto.targetGrade,
      isActive: true,
    });
    courseIds.forEach((courseId, i) => {
      this.db.insert<RoadmapCourse>(ROADMAP_COURSES, { roadmapId: roadmap.id, courseId, sortOrder: i });
    });
    return roadmap;
  }
}
