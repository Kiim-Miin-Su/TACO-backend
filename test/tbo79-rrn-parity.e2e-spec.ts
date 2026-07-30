// [TBO-79 I1 2026-07-30] RRN 규칙의 tier 간 동형 회귀.
//
//  결함: backend `common/rrn-crypto.util.ts`와 frontend `lib/validation.ts`가 같은 규칙을
//  각자 구현했고 두 군데가 갈라져 있었다.
//   ① 공백 — FE는 `value.trim()` 후 검사, BE는 원문 그대로 검사. `'950101-1234567 '`가
//      화면에서는 "올바름"이고 저장에서 400이 됐다. **실제 도달 가능한 불일치**다.
//   ② 하이픈 — BE `digitsOf`는 `replace('-', '')`로 첫 하이픈만, FE는 전부 제거.
//      성별 자리(index 6)가 밀리면 `birthYearFromRrn`의 세기 판정이 뒤집혀 잘못된
//      birthYear가 **영속**된다.
//
//  이제 두 tier 모두 contracts/src/rrn.ts 하나를 소비하므로 구조적으로 갈라질 수 없다.
//  아래 진리표는 그 계약을 문서화하고, 누군가 다시 로컬 사본을 만들면 깨지도록 고정한다.
//  같은 표가 frontend lib/validation.test.ts 에도 있다 — 두 표가 어긋나면 재분기 신호다.
import {
  RRN_REGEX,
  birthYearFromRrn,
  maskRrn,
  normalizeRrn,
  rrnDigits,
  validateRrnFormat,
} from '../src/common/rrn-crypto.util';

describe('[TBO-79] RRN 규칙 tier 동형', () => {
  it.each([
    ['950101-1234567', true],
    ['9501011234567', true],
    // ↓ 종전 BE가 거부하고 FE가 통과시키던 자리 — 이제 둘 다 통과한다.
    [' 950101-1234567 ', true],
    ['950101-1234567 ', true],
    [' 9501011234567', true],
    ['001231-4234567', true], // 2000년대(성별 3·4)
    ['950101-8234567', true], // 외국인(5-8)
    ['950101-9234567', false], // 성별 자리 9 불가
    ['951301-1234567', false], // MM=13
    ['950132-1234567', false], // DD=32
    ['95010-11234567', false], // 자릿수 어긋남
    ['', false],
  ])('형식 검증 %s → %s', (input, expected) => {
    expect(validateRrnFormat(input)).toBe(expected);
  });

  it('정규화·마스킹·출생연도는 하이픈/공백 표기에 무관하게 같은 값을 낸다', () => {
    const variants = ['950101-1234567', '9501011234567', ' 950101-1234567 '];
    for (const value of variants) {
      expect(rrnDigits(value)).toBe('9501011234567');
      expect(normalizeRrn(value)).toBe('950101-1234567');
      expect(maskRrn(value)).toBe('950101-1******');
      expect(birthYearFromRrn(value)).toBe(1995);
    }
  });

  it('세기 판정 — 성별 자리 1,2,5,6은 19xx / 3,4,7,8은 20xx', () => {
    expect(birthYearFromRrn('950101-1234567')).toBe(1995);
    expect(birthYearFromRrn('950101-2234567')).toBe(1995);
    expect(birthYearFromRrn('950101-5234567')).toBe(1995);
    expect(birthYearFromRrn('950101-6234567')).toBe(1995);
    expect(birthYearFromRrn('001231-3234567')).toBe(2000);
    expect(birthYearFromRrn('001231-4234567')).toBe(2000);
    expect(birthYearFromRrn('001231-7234567')).toBe(2000);
    expect(birthYearFromRrn('001231-8234567')).toBe(2000);
  });

  it('마스킹 결과에는 뒷자리 6개가 남지 않는다(노출 규약)', () => {
    const masked = maskRrn('950101-1234567');
    expect(masked).toBe('950101-1******');
    expect(masked).not.toContain('234567');
  });

  it('정규식은 하이픈을 선택으로 허용하고 성별 자리를 1~8로 제한한다', () => {
    expect(RRN_REGEX.test('950101-1234567')).toBe(true);
    expect(RRN_REGEX.test('9501011234567')).toBe(true);
    expect(RRN_REGEX.test('950101-0234567')).toBe(false);
    expect(RRN_REGEX.test('950101-9234567')).toBe(false);
  });
});
