// [R-3 함수 통일 회귀 가드] common/time.util 순수 함수 계약 고정.
//  통일 전 각 모듈 인라인 버전과 동작 동일함을 잠그고, **의도적 시맨틱 분기**(허용형 vs 가드형)를
//  문서화한다. 앱 부팅 없음 — 순수 import(e2e 하네스 testRegex .e2e-spec.ts$ 재사용, 설정 무변경).
import {
  hhmmToMin,
  minToHhmm,
  addMinutes,
  weekdayOf,
  dateToYmd,
  addDaysISO,
  dayDiff,
} from '../src/common/time.util';

describe('common/time.util (R-3)', () => {
  it('hhmmToMin ↔ minToHhmm 왕복', () => {
    expect(hhmmToMin('16:30')).toBe(990);
    expect(hhmmToMin('00:00')).toBe(0);
    expect(minToHhmm(990)).toBe('16:30');
    expect(minToHhmm(hhmmToMin('09:05'))).toBe('09:05');
  });

  it('addMinutes는 허용형 — 자정 초과를 25:00 형태로 그대로 반환(표시/파생 전용·저장 금지)', () => {
    expect(addMinutes('16:00', 90)).toBe('17:30');
    expect(addMinutes('23:00', 120)).toBe('25:00'); // 자정 크로스: 저장하면 안 됨(HH:mm 계약 위반)
    expect(addMinutes('23:59', 1)).toBe('24:00');
  });

  it('weekdayOf — UTC 요일(0=일~6=토)', () => {
    expect(weekdayOf('2026-07-05')).toBe(0); // 일
    expect(weekdayOf('2026-07-06')).toBe(1); // 월
    expect(weekdayOf('2026-07-11')).toBe(6); // 토
  });

  it('dateToYmd — UTC Date → YYYY-MM-DD(0패딩)', () => {
    expect(dateToYmd(new Date(Date.UTC(2026, 0, 5)))).toBe('2026-01-05');
    expect(dateToYmd(new Date(Date.UTC(2026, 11, 31)))).toBe('2026-12-31');
  });

  it('addDaysISO — 월/년 경계 넘김(윤년 아님)', () => {
    expect(addDaysISO('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysISO('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDaysISO('2026-07-06', 0)).toBe('2026-07-06');
  });

  it('dayDiff — a - b 일수', () => {
    expect(dayDiff('2026-07-06', '2026-07-01')).toBe(5);
    expect(dayDiff('2026-07-01', '2026-07-06')).toBe(-5);
    expect(dayDiff('2027-01-01', '2026-12-31')).toBe(1);
  });
});
