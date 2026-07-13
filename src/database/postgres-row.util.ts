export type PostgresRow = Record<string, unknown>;

export const camelToSnake = (key: string): string =>
  key.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`);

export const snakeToCamel = (key: string): string =>
  key.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase());

export function parseJson(value: unknown): unknown {
  if (value == null || typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function parseJsonNumberArray(value: unknown): number[] | undefined {
  const parsed = Array.isArray(value) ? value : parseJson(value);
  if (!Array.isArray(parsed)) return undefined;
  return parsed.map(Number).filter(Number.isFinite);
}

export function toIsoString(value: unknown): string | null | undefined {
  if (value == null) return value as null | undefined;
  return value instanceof Date ? value.toISOString() : String(value);
}

export function toDateString(value: unknown): string | null | undefined {
  if (value == null) return value as null | undefined;
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return String(value).slice(0, 10);
}

export function normalizeQueryRows<T extends PostgresRow = PostgresRow>(result: unknown): T[] {
  if (!Array.isArray(result)) return [];
  if (Array.isArray(result[0]) && typeof result[1] === 'number') return result[0] as T[];
  return result as T[];
}
