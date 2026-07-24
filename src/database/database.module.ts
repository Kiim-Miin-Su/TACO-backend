import { Global, Module } from '@nestjs/common';
import { InMemoryDatabase } from './in-memory.database';
import { PostgresCollectionStore } from './postgres-collection.store';
import { PostgresConnectionService } from './postgres-connection.service';
import { CalendarUnitOfWork } from './calendar-unit-of-work.service';
import { AccountStateService } from './account-state.service';
import { DbAnalyticsSnapshotRepository } from './db-analytics-snapshot.repository';
import { ClassSessionsStore } from '../modules/schedule/class-sessions.store';

// [TBO-29C C1] ClassSessionsStore를 @Global 데이터 계층으로 이동 — AvailabilityService가 잠금 후
//  세션 투영을 권위 재조회해야 하는데, ScheduleModule ← AvailabilityModule 역방향 import는 순환이라
//  DB 계층(모든 캘린더 자산 투영의 원 소유 계층)에서 제공한다. Schedule/Availability 둘 다 동일 인스턴스 주입.
@Global()
@Module({
  providers: [InMemoryDatabase, PostgresConnectionService, PostgresCollectionStore, CalendarUnitOfWork, AccountStateService, ClassSessionsStore, DbAnalyticsSnapshotRepository],
  exports: [InMemoryDatabase, PostgresConnectionService, PostgresCollectionStore, CalendarUnitOfWork, AccountStateService, ClassSessionsStore, DbAnalyticsSnapshotRepository],
})
export class DatabaseModule {}
