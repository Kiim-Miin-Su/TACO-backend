import { InMemoryDatabase } from '../src/database/in-memory.database';
// [TBO-69 C1] hydrate 게이트(ensureReady)는 읽기 서비스 소유로 이동 — 스펙도 소유자를 따라간다.
//  (명령 schedule.service의 refreshAfterLock은 이 ensureReady를 단방향 경유 — 규약 무변)
import { ScheduleReadService } from '../src/modules/schedule/schedule-read.service';

describe('ScheduleReadService DB read-model hydration', () => {
  it('서버리스 조회 전에 일정 조인에 필요한 모든 DB 컬렉션을 재수화한다', async () => {
    const hydrated: string[] = [];
    const sessions = { ensureReady: jest.fn(async () => undefined) };
    const availability = { refresh: jest.fn(async () => undefined) };
    const collections = {
      hydrate: jest.fn(async (spec: { table: string }) => {
        hydrated.push(spec.table);
        return [];
      }),
    };
    const service = new ScheduleReadService(
      new InMemoryDatabase(),
      sessions as never,
      { inPgTransaction: false } as never,
      {} as never,
      availability as never,
      collections as never,
      {} as never,
    );

    await service.ensureReady();

    expect(sessions.ensureReady).toHaveBeenCalledTimes(1);
    expect(availability.refresh).toHaveBeenCalledTimes(1);
    expect(new Set(hydrated)).toEqual(new Set([
      'users',
      'class_session_series',
      'courses',
      'subjects',
      'enrollments',
      'students',
      'rooms', // [TBO-66 R2] 강의실 미러도 조회 전 재수화(정원·검증·표기)
    ]));
  });
});
