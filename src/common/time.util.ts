// [R-3 함수 통일 2026-07-06] 벽시계(wall-clock) 시간·날짜 유틸 단일 소스.
//  schedule.service · conflict.util · availability.service · payouts.service 에 흩어져 있던
//  동일 로직(toMin/weekdayOf/addDaysISO/dayDiff 등)을 여기로 통일한다(KST 의존 없음 — 순수 함수).
//
//  ⚠ 시맨틱 주의: 여기 addMinutes/minToHhmm 는 **허용형**(24:00 이상이면 '25:00' 같은 문자열을 그대로 반환).
//     표시/파생 계산용이며 **저장 값(HH:mm 계약)으로 쓰지 말 것**. 자정 크로스 저장은 endTime 미기록
//     + durationMinutes 파생 규칙(schedule R-9)을 따른다. 범위를 강제하는 **가드형**이 필요한 곳
//     (schedule 시리즈 델타 [M3])은 이 primitive 위에 로컬 가드를 얹는다(schedule.service.addMinutes).

/** "HH:mm" → 분(00:00 기준). */
export const hhmmToMin = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** 분 → "HH:mm"(허용형 — 1440 이상도 '24:00'+ 로 그대로 표기). 저장 금지·표시/파생 전용. */
export const minToHhmm = (totalMin: number): string =>
  `${String(Math.floor(totalMin / 60)).padStart(2, '0')}:${String(totalMin % 60).padStart(2, '0')}`;

/** "HH:mm" + 분 → "HH:mm"(허용형). = minToHhmm(hhmmToMin(hhmm)+mins). */
export const addMinutes = (hhmm: string, mins: number): string => minToHhmm(hhmmToMin(hhmm) + mins);

/** 시작/종료 벽시각의 진행 분. 종료가 더 이르면 익일 종료로 해석한다. */
export const durationMinutesBetween = (startTime: string, endTime: string): number => {
  const delta = hhmmToMin(endTime) - hhmmToMin(startTime);
  return delta < 0 ? delta + 1440 : delta;
};

/** "YYYY-MM-DD" → 요일(0=일 ~ 6=토, UTC 기준). */
export const weekdayOf = (dateStr: string): number => new Date(dateStr + 'T00:00:00Z').getUTCDay();

/** Date(UTC) → "YYYY-MM-DD". */
export const dateToYmd = (d: Date): string =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

/** "YYYY-MM-DD" + 일수 → "YYYY-MM-DD"(UTC). */
export const addDaysISO = (dateStr: string, days: number): string => {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return dateToYmd(d);
};

/** 두 "YYYY-MM-DD"의 일수 차(a - b, UTC 기준 반올림). */
export const dayDiff = (a: string, b: string): number =>
  Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86_400_000);

// ── [TBO-65 M2 2026-07-24] KST '오늘' 단일 진실원 ──
//  종전엔 dateInTimeZone(student-grade.policy)·en-CA toLocaleDateString(students.today)·
//  UTC toISOString().slice(0,10)(enrollments·counsel·ceoDashboard·uncovered)이 산개 —
//  KST 자정~09:00 사이 "오늘"이 하루 어긋났다(도메인 스탬프·집계 기준일). 여기 하나만 쓴다.
export function dateInTimeZone(now = new Date(), timeZone = 'Asia/Seoul'): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const value = (type: 'year' | 'month' | 'day') => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

/** 도메인 날짜 스탬프·집계 기준일용 KST 오늘(YYYY-MM-DD). */
export const todayKst = (now = new Date()): string => dateInTimeZone(now);
