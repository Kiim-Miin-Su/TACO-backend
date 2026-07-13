import { Global, Module } from '@nestjs/common';
import { InMemoryDatabase } from './in-memory.database';
import { PostgresCollectionStore } from './postgres-collection.store';
import { PostgresConnectionService } from './postgres-connection.service';
import { CalendarUnitOfWork } from './calendar-unit-of-work.service';

@Global()
@Module({
  providers: [InMemoryDatabase, PostgresConnectionService, PostgresCollectionStore, CalendarUnitOfWork],
  exports: [InMemoryDatabase, PostgresConnectionService, PostgresCollectionStore, CalendarUnitOfWork],
})
export class DatabaseModule {}
