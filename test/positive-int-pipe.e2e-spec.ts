import { BadRequestException } from '@nestjs/common';
import {
  OptionalBoundedIntPipe,
  OptionalPositiveIntPipe,
  PositiveIntPipe,
  RawPositiveIntBoundaryPipe,
} from '../src/common/positive-int.pipe';

describe('PositiveIntPipe', () => {
  const pipe = new PositiveIntPipe();

  it.each([
    ['1', 1],
    ['42', 42],
    ['2147483647', 2_147_483_647],
    [1, 1],
    [2_147_483_647, 2_147_483_647],
  ])('accepts canonical PostgreSQL integer id %p', (candidate, expected) => {
    expect(pipe.transform(candidate)).toBe(expected);
  });

  it.each([
    '',
    ' ',
    'NaN',
    'Infinity',
    '0',
    '-1',
    '+1',
    '01',
    '1.0',
    '1.5',
    '1e3',
    '１２',
    '2147483648',
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    2_147_483_648,
    null,
    undefined,
  ])('rejects invalid id %p', (candidate) => {
    expect(() => pipe.transform(candidate)).toThrow(BadRequestException);
  });
});

describe('OptionalPositiveIntPipe', () => {
  const pipe = new OptionalPositiveIntPipe();

  it('keeps an omitted query undefined', () => {
    expect(pipe.transform(undefined)).toBeUndefined();
  });

  it('uses the same canonical boundary when a query is present', () => {
    expect(pipe.transform('7')).toBe(7);
    expect(() => pipe.transform('0')).toThrow(BadRequestException);
    expect(() => pipe.transform('01')).toThrow(BadRequestException);
  });
});

describe('RawPositiveIntBoundaryPipe', () => {
  const pipe = new RawPositiveIntBoundaryPipe();

  it('rejects non-canonical text before global number transformation', () => {
    const metadata = { type: 'param', metatype: Number, data: 'id' } as const;
    expect(() => pipe.transform('01', metadata)).toThrow(BadRequestException);
    expect(() => pipe.transform('1.0', metadata)).toThrow(BadRequestException);
    expect(pipe.transform('1', metadata)).toBe('1');
  });

  it('does not reinterpret body DTO values or string queries', () => {
    expect(
      pipe.transform('01', { type: 'body', metatype: Number }),
    ).toBe('01');
    expect(
      pipe.transform('01', { type: 'query', metatype: String }),
    ).toBe('01');
  });
});

describe('OptionalBoundedIntPipe', () => {
  const pipe = new OptionalBoundedIntPipe(1, 12, 'months');

  it('accepts omission and values inside the business range', () => {
    expect(pipe.transform(undefined)).toBeUndefined();
    expect(pipe.transform('1')).toBe(1);
    expect(pipe.transform('12')).toBe(12);
  });

  it.each(['0', '01', '13', '1.5', '2147483648'])(
    'rejects non-canonical or out-of-range value %s',
    (candidate) => {
      expect(() => pipe.transform(candidate)).toThrow(BadRequestException);
    },
  );
});
