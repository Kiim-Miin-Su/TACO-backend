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

export function dateInTimeZone(now = new Date(), timeZone = 'Asia/Seoul'): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const value = (type: 'year' | 'month' | 'day') => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
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
