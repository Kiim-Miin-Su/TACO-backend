import type { Course, StoredCourse } from './course.entity';
import type { InstructorProfile } from '../users/instructor-profiles.store';

/**
 * 수업 유효 시급의 단일 정책.
 * explicit course override > instructor profile default.
 * DB에는 override만 저장하고 `hourlyRate`는 API 응답 시 계산한다.
 */
export function effectiveCourseHourlyRate(
  course: Pick<StoredCourse, 'hourlyRateOverride'>,
  profile?: Pick<InstructorProfile, 'defaultHourlyRate'> | null,
): number {
  if (course.hourlyRateOverride != null) return course.hourlyRateOverride;
  return profile?.defaultHourlyRate ?? 0;
}

export function withEffectiveCourseRate(course: StoredCourse, profile?: InstructorProfile | null): Course {
  return { ...course, hourlyRate: effectiveCourseHourlyRate(course, profile) };
}
