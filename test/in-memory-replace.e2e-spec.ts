import { InMemoryDatabase, type BaseRow } from '../src/database/in-memory.database';

type Row = BaseRow & { ownerId: number; label: string };

describe('InMemoryDatabase.replaceExact', () => {
  it('replaces stale rows and rebuilds id/field indexes', () => {
    const db = new InMemoryDatabase();
    const now = new Date().toISOString();
    db.seedExact<Row>('rows', [
      { id: 1, ownerId: 10, label: 'stale', createdAt: now, updatedAt: now },
      { id: 2, ownerId: 20, label: 'before', createdAt: now, updatedAt: now },
    ]);

    expect(db.findByField<Row>('rows', 'ownerId', 10)).toHaveLength(1);

    db.replaceExact<Row>('rows', [
      { id: 2, ownerId: 30, label: 'after', createdAt: now, updatedAt: now },
      { id: 3, ownerId: 40, label: 'new', createdAt: now, updatedAt: now },
    ]);

    expect(db.findById<Row>('rows', 1)).toBeUndefined();
    expect(db.findById<Row>('rows', 2)).toMatchObject({ ownerId: 30, label: 'after' });
    expect(db.findByField<Row>('rows', 'ownerId', 10)).toEqual([]);
    expect(db.findByField<Row>('rows', 'ownerId', 30)).toHaveLength(1);
    expect(db.findAll<Row>('rows').map((row) => row.id)).toEqual([2, 3]);
  });
});
