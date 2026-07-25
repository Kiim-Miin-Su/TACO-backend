const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function ageOnDate(birthDate: string, onDate: string): number | null {
  const birth = ISO_DATE_PATTERN.exec(birthDate);
  const current = ISO_DATE_PATTERN.exec(onDate);
  if (!birth || !current) return null;
  const birthYear = Number(birth[1]);
  const birthMonth = Number(birth[2]);
  const birthDay = Number(birth[3]);
  const currentYear = Number(current[1]);
  const currentMonth = Number(current[2]);
  const currentDay = Number(current[3]);
  let age = currentYear - birthYear;
  if (currentMonth < birthMonth || (currentMonth === birthMonth && currentDay < birthDay)) age -= 1;
  return age;
}

// [TBO-65 M2] 정본은 common/time.util로 이관 — 기존 import 경로 호환을 위한 재수출.
import { dateInTimeZone } from '../../common/time.util';
export { dateInTimeZone };

/** 학생 학년 표시는 모든 backend projection에서 같은 계약을 사용한다. */
export function studentGradeLabel(grade: number | null | undefined): string | undefined {
  if (grade == null) return undefined;
  return grade === 0 ? 'Kinder' : `G${grade}`;
}

/** grade=0(Kinder)은 저장일 기준 만 3~7세만 허용한다. */
export function studentGradeBirthDateError(
  grade: number | null | undefined,
  birthDate: string | null | undefined,
  today = dateInTimeZone(),
): string | null {
  if (grade == null || !birthDate) return '생년월일과 학년은 필수입니다.';
  if (grade !== 0) return null;
  const age = ageOnDate(birthDate, today);
  return age != null && age >= 3 && age <= 7
    ? null
    : 'Kinder 학년은 생년월일 기준 만 3~7세만 선택할 수 있습니다.';
}
