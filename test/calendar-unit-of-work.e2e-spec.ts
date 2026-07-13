import { CalendarUnitOfWork } from '../src/database/calendar-unit-of-work.service';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import type { PostgresConnectionService } from '../src/database/postgres-connection.service';

describe('CalendarUnitOfWork', () => {
  it('uses the Postgres transaction boundary and rolls memory back on failure', async () => {
    const memory = new InMemoryDatabase();
    const transaction = jest.fn(async <T>(fn: () => Promise<T>) => fn());
    const unit = new CalendarUnitOfWork(
      { transaction } as unknown as PostgresConnectionService,
      memory,
    );

    await expect(unit.run(async () => {
      memory.insert('calendar_uow_test', { value: 'temporary' });
      throw new Error('audit failed');
    })).rejects.toThrow('audit failed');

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(memory.findAll('calendar_uow_test')).toEqual([]);
  });

  it('commits the memory projection after a successful transaction', async () => {
    const memory = new InMemoryDatabase();
    const transaction = jest.fn(async <T>(fn: () => Promise<T>) => fn());
    const unit = new CalendarUnitOfWork(
      { transaction } as unknown as PostgresConnectionService,
      memory,
    );

    await unit.run(async () => {
      memory.insert('calendar_uow_test', { value: 'committed' });
    });

    expect(memory.findAll('calendar_uow_test')).toHaveLength(1);
  });

  it('rolls memory back when the Postgres commit fails after the callback', async () => {
    const memory = new InMemoryDatabase();
    const transaction = jest.fn(async <T>(fn: () => Promise<T>) => {
      await fn();
      throw new Error('commit failed');
    });
    const unit = new CalendarUnitOfWork(
      { transaction } as unknown as PostgresConnectionService,
      memory,
    );

    await expect(unit.run(async () => {
      memory.insert('calendar_uow_test', { value: 'must rollback' });
    })).rejects.toThrow('commit failed');

    expect(memory.findAll('calendar_uow_test')).toEqual([]);
  });
});
