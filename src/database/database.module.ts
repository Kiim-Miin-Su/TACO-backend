import { Global, Module } from '@nestjs/common';
import { InMemoryDatabase } from './in-memory.database';
import { PostgresCollectionStore } from './postgres-collection.store';
import { PostgresConnectionService } from './postgres-connection.service';
import { CalendarUnitOfWork } from './calendar-unit-of-work.service';
import { AccountStateService } from './account-state.service';

@Global()
@Module({
  providers: [InMemoryDatabase, PostgresConnectionService, PostgresCollectionStore, CalendarUnitOfWork, AccountStateService],
  exports: [InMemoryDatabase, PostgresConnectionService, PostgresCollectionStore, CalendarUnitOfWork, AccountStateService],
})
export class DatabaseModule {}
