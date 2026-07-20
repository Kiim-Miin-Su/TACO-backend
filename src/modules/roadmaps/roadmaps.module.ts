import { Module } from '@nestjs/common';
import { RoadmapsService } from './roadmaps.service';
import { RoadmapsController } from './roadmaps.controller';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../../database/database.module';

// [참조/처리] 카탈로그 모듈(무가드). 서비스가 courses 컬렉션을 참조해 courseIds FK 검증.
@Module({
  imports: [AuthModule, AuditModule, DatabaseModule], // DB write-through + 같은 tx audit
  controllers: [RoadmapsController],
  providers: [RoadmapsService],
  exports: [RoadmapsService],
})
export class RoadmapsModule {}
