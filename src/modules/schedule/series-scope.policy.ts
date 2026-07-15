// [TBO-29C C3] 반복 편집/삭제의 scope 대상 회차 선택 — **순수 함수**(잠금/DB 무관, 단위 테스트 대상).
//  순서 기준: (sessionDate, startTime, id) 사전식. 같은 날짜의 다른 회차도 시간·id로 결정적으로 판정한다
//  (구 구현은 sessionDate > pivot만 봐서 같은 날짜의 늦은 회차가 this_and_following에서 빠졌다).
export type SeriesScope = 'this' | 'this_and_following' | 'all';

export type SeriesScopeMember = {
  id: number;
  sessionDate: string; // ISO date
  startTime?: string; // 'HH:mm'
};

const orderKey = (m: SeriesScopeMember): string =>
  `${m.sessionDate}|${m.startTime ?? '99:99'}|${String(m.id).padStart(12, '0')}`;

/** pivot을 제외한 동반 편집/삭제 대상. scope=this는 빈 배열(대상=pivot 단독). */
export function selectSeriesScope<T extends SeriesScopeMember>(members: T[], pivot: SeriesScopeMember, scope: SeriesScope): T[] {
  if (scope === 'this') return [];
  const pivotKey = orderKey(pivot);
  return members
    .filter((m) => m.id !== pivot.id && (scope === 'all' || orderKey(m) > pivotKey))
    .sort((a, b) => orderKey(a).localeCompare(orderKey(b)));
}
