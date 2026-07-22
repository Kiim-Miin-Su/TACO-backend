import type { INestApplication } from '@nestjs/common';
import type { BaseRow } from '../../src/common/types/base';
import { InMemoryDatabase } from '../../src/database/in-memory.database';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fixtureTables = require('./business-fixtures.json') as Record<string, BaseRow[]>;

const SNAPSHOT_WEEK_START = '2026-07-20';

function currentMonday(): string {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const weekday = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() + (weekday === 0 ? -6 : 1 - weekday));
  return date.toISOString().slice(0, 10);
}

function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function fixtureRows(table: string): BaseRow[] {
  const shiftDays = Math.round(
    (Date.parse(`${currentMonday()}T00:00:00Z`) - Date.parse(`${SNAPSHOT_WEEK_START}T00:00:00Z`)) / 86_400_000,
  );
  return fixtureTables[table].map((row) => {
    const copy = structuredClone(row) as BaseRow & Record<string, unknown>;
    if (table === 'class_session_series') {
      copy.startsOn = shiftDate(String(copy.startsOn), shiftDays);
      copy.endsOn = shiftDate(String(copy.endsOn), shiftDays);
    }
    if (table === 'class_sessions' && copy.seriesId != null) {
      copy.sessionDate = shiftDate(String(copy.sessionDate), shiftDays);
    }
    return copy;
  });
}

export function seedBusinessFixtures(app: INestApplication): void {
  const db = app.get(InMemoryDatabase);
  for (const table of Object.keys(fixtureTables)) {
    db.seedExact(table, fixtureRows(table));
  }
}
