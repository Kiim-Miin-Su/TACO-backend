import { InMemoryDatabase } from '../src/database/in-memory.database';
import { ScheduleService } from '../src/modules/schedule/schedule.service';

describe('ScheduleService DB read-model hydration', () => {
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
    const service = new ScheduleService(
      new InMemoryDatabase(),
      sessions as never,
      { inPgTransaction: false } as never,
      {} as never,
      availability as never,
      {} as never,
      {} as never,
      {} as never,
      collections as never,
      {} as never,
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
    ]));
  });
});
