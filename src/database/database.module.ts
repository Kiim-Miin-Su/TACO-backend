import { Global, Module } from '@nestjs/common';
import { InMemoryDatabase } from './in-memory.database';
import { PostgresCollectionStore } from './postgres-collection.store';
import { PostgresConnectionService } from './postgres-connection.service';

@Global()
@Module({
  providers: [InMemoryDatabase, PostgresConnectionService, PostgresCollectionStore],
  exports: [InMemoryDatabase, PostgresConnectionService, PostgresCollectionStore],
})
export class DatabaseModule {}
