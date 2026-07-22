import { InMemoryDatabase, BaseRow } from '../src/database/in-memory.database';

// ─────────────────────────────────────────────────────────────
// [최적화 2026-07-02] InMemoryDatabase 단위 검증 — 트랜잭션(원자성)·인덱스 정합.
//  다중 쓰기 서비스(payouts.pay/generate/reject·payments.markPaid·expenses.approve·
//  students.remove·parents.create·counsel.createRound·schedule.update scope)가 이 계약에 의존.
// ─────────────────────────────────────────────────────────────
type Row = BaseRow & { name: string; groupId?: number };
const C = 'tx_test';

describe('InMemoryDatabase — transaction & index', () => {
  let db: InMemoryDatabase;
  beforeEach(() => { db = new InMemoryDatabase(); });

  // [async 전환 2026-07-07] transaction은 이제 Promise 반환 — await / .rejects 로 검증.
  it('트랜잭션 커밋: fn 정상 완료 시 모든 쓰기가 반영된다', async () => {
    const out = await db.transaction(() => {
      const a = db.insert<Row>(C, { name: 'a' });
      db.update<Row>(C, a.id, { name: 'a2' });
      return a.id;
    });
    expect(db.findById<Row>(C, out)?.name).toBe('a2');
    expect(db.findAll(C)).toHaveLength(1);
  });

  it('트랜잭션 롤백: 중간 예외 시 insert/update/remove·시퀀스까지 전부 원복(부분 쓰기 잔존 금지)', async () => {
    const keep = db.insert<Row>(C, { name: 'keep' });
    await expect(
      db.transaction(() => {
        db.insert<Row>(C, { name: 'ghost' });
        db.update<Row>(C, keep.id, { name: 'mutated' });
        db.remove(C, keep.id);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const rows = db.findAll<Row>(C);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('keep'); // update 원복
    expect(db.findById<Row>(C, keep.id)?.name).toBe('keep'); // id 인덱스도 스냅샷과 정합
    const next = db.insert<Row>(C, { name: 'after' });
    expect(next.id).toBe(keep.id + 1); // 시퀀스 원복(ghost의 id 소비도 롤백)
  });

  it('중첩 트랜잭션: 최외곽 경계 기준으로 원자성 유지', async () => {
    await expect(
      db.transaction(async () => {
        db.insert<Row>(C, { name: 'outer' });
        await db.transaction(() => { // 내부 tx는 반드시 await(실제 코드 패턴: schedule-requests.approve→schedule.create)
          db.insert<Row>(C, { name: 'inner' });
        });
        throw new Error('outer-fail');
      }),
    ).rejects.toThrow('outer-fail');
    expect(db.findAll(C)).toHaveLength(0); // inner 포함 전부 롤백
  });

  it('findByField(세컨더리 인덱스): insert/update/remove를 자동 추적한다', () => {
    const a = db.insert<Row>(C, { name: 'a', groupId: 1 });
    const b = db.insert<Row>(C, { name: 'b', groupId: 1 });
    db.insert<Row>(C, { name: 'c', groupId: 2 });
    expect(db.findByField<Row>(C, 'groupId', 1).map((r) => r.name).sort()).toEqual(['a', 'b']);
    db.update<Row>(C, a.id, { groupId: 2 }); // 버킷 이동
    expect(db.findByField<Row>(C, 'groupId', 1).map((r) => r.name)).toEqual(['b']);
    expect(db.findByField<Row>(C, 'groupId', 2).map((r) => r.name).sort()).toEqual(['a', 'c']);
    db.remove(C, b.id);
    expect(db.findByField<Row>(C, 'groupId', 1)).toHaveLength(0);
  });

  it('롤백 후에도 인덱스가 스냅샷 데이터와 정합(findByField 재조회)', async () => {
    db.insert<Row>(C, { name: 'x', groupId: 7 });
    expect(db.findByField<Row>(C, 'groupId', 7)).toHaveLength(1); // 인덱스 생성
    await expect(
      db.transaction(() => {
        db.insert<Row>(C, { name: 'y', groupId: 7 });
        throw new Error('rollback');
      }),
    ).rejects.toThrow();
    expect(db.findByField<Row>(C, 'groupId', 7).map((r) => r.name)).toEqual(['x']);
  });

  it('findById는 remove 후 미스, seed 고정 id와 insert 시퀀스가 충돌하지 않는다', () => {
    db.seedReference<Row>(C, [{ id: 10, name: 'seeded' }]);
    expect(db.findById<Row>(C, 10)?.name).toBe('seeded');
    const n = db.insert<Row>(C, { name: 'next' });
    expect(n.id).toBe(11);
    db.remove(C, 10);
    expect(db.findById(C, 10)).toBeUndefined();
  });
});
