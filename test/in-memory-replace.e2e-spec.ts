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

  it('does not rebuild indexes for an unrelated collection', () => {
    const db = new InMemoryDatabase();
    const now = new Date().toISOString();
    db.seedExact<Row>('target', [
      { id: 1, ownerId: 10, label: 'before', createdAt: now, updatedAt: now },
    ]);
    db.seedExact<Row>('untouched', [
      { id: 2, ownerId: 20, label: 'stable', createdAt: now, updatedAt: now },
    ]);
    db.findByField<Row>('target', 'ownerId', 10);
    db.findByField<Row>('untouched', 'ownerId', 20);

    const internals = db as unknown as {
      idIndex: Map<string, Map<number, BaseRow>>;
      fieldIndex: Map<string, Map<string, Map<unknown, Set<BaseRow>>>>;
    };
    const untouchedIds = internals.idIndex.get('untouched');
    const untouchedFields = internals.fieldIndex.get('untouched');

    db.replaceExact<Row>('target', [
      { id: 3, ownerId: 30, label: 'after', createdAt: now, updatedAt: now },
    ]);

    expect(internals.idIndex.get('untouched')).toBe(untouchedIds);
    expect(internals.fieldIndex.get('untouched')).toBe(untouchedFields);
    expect(db.findByField<Row>('untouched', 'ownerId', 20)).toHaveLength(1);
    expect(db.findByField<Row>('target', 'ownerId', 10)).toEqual([]);
    expect(db.findByField<Row>('target', 'ownerId', 30)).toHaveLength(1);
  });
});
