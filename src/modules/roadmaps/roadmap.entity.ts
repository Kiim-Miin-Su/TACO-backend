import type { Roadmap as RoadmapContract, RoadmapCourse as RoadmapCourseContract } from '@kms545487/contracts';
import type { BaseRow } from '../../common/types/base';

// [참조/처리] 로드맵 = 코스 묶음(카탈로그). roadmap_courses가 roadmap↔course M:N 조인.
//  - RoadmapCourse.roadmapId → roadmaps.id, courseId → courses.id (서비스에서 FK 검증).
//  - (roadmapId, courseId) 유니크 + sortOrder로 순서 보존.
export type Roadmap = RoadmapContract & BaseRow;
export type RoadmapCourse = RoadmapCourseContract & BaseRow;
export const ROADMAPS = 'roadmaps';
export const ROADMAP_COURSES = 'roadmap_courses';
