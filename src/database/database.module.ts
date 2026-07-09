import { Global, Module } from '@nestjs/common';
import { InMemoryDatabase } from './in-memory.database';
import { PostgresConnectionService } from './postgres-connection.service';

@Global()
@Module({
  providers: [InMemoryDatabase, PostgresConnectionService],
  exports: [InMemoryDatabase, PostgresConnectionService],
})
export class DatabaseModule {}
