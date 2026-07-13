import { Injectable } from '@nestjs/common';
import { InMemoryDatabase } from './in-memory.database';
import { PostgresConnectionService } from './postgres-connection.service';

@Injectable()
export class CalendarUnitOfWork {
  constructor(
    private readonly postgres: PostgresConnectionService,
    private readonly memory: InMemoryDatabase,
  ) {}

  run<T>(fn: () => T | Promise<T>): Promise<T> {
    return this.memory.transaction(() => this.postgres.transaction(async () => fn()));
  }
}
