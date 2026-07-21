import type { Course } from './course.entity';
import type { InstructorProfile } from '../users/instructor-profiles.store';

/**
 * 수업 유효 시급의 단일 정책.
 * explicit course override > instructor profile default > migration 기간의 legacy course hourly_rate.
 * 마지막 fallback은 36G backfill/contract migration이 끝날 때까지만 기존 요율을 무손실 보존한다.
 */
export function effectiveCourseHourlyRate(
  course: Pick<Course, 'hourlyRate' | 'hourlyRateOverride'>,
  profile?: Pick<InstructorProfile, 'defaultHourlyRate'> | null,
): number {
  if (course.hourlyRateOverride != null) return course.hourlyRateOverride;
  const defaultRate = profile?.defaultHourlyRate ?? 0;
  if (defaultRate > 0) return defaultRate;
  return course.hourlyRate;
}

export function withEffectiveCourseRate(course: Course, profile?: InstructorProfile | null): Course {
  return { ...course, hourlyRate: effectiveCourseHourlyRate(course, profile) };
}
