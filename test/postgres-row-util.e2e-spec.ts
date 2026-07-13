import {
  camelToSnake,
  normalizeQueryRows,
  parseJson,
  parseJsonNumberArray,
  snakeToCamel,
  toDateString,
  toIsoString,
} from '../src/database/postgres-row.util';

describe('Postgres row utilities', () => {
  it('maps camel/snake names consistently', () => {
    expect(camelToSnake('availabilityOwnerId')).toBe('availability_owner_id');
    expect(snakeToCamel('availability_owner_id')).toBe('availabilityOwnerId');
  });

  it('normalizes JSON number arrays and leaves invalid JSON unchanged', () => {
    expect(parseJsonNumberArray('[1,"2","x"]')).toEqual([1, 2]);
    expect(parseJsonNumberArray([3, '4'])).toEqual([3, 4]);
    expect(parseJson('{bad')).toBe('{bad');
  });

  it('normalizes dates and timestamps without timezone-dependent date slicing', () => {
    const date = new Date(2026, 6, 13, 12, 0, 0);
    expect(toDateString(date)).toBe('2026-07-13');
    expect(toDateString('2026-07-13T23:00:00Z')).toBe('2026-07-13');
    expect(toIsoString(new Date('2026-07-13T03:00:00Z'))).toBe('2026-07-13T03:00:00.000Z');
  });

  it('accepts both pg row arrays and TypeORM tuple-shaped query results', () => {
    const rows = [{ id: 1 }];
    expect(normalizeQueryRows(rows)).toEqual(rows);
    expect(normalizeQueryRows([rows, 1])).toEqual(rows);
    expect(normalizeQueryRows(undefined)).toEqual([]);
  });
});
