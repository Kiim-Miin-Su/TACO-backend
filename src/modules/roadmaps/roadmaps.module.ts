import { Module } from '@nestjs/common';
import { RoadmapsService } from './roadmaps.service';
import { RoadmapsController } from './roadmaps.controller';

// [참조/처리] 카탈로그 모듈(무가드). 서비스가 courses 컬렉션을 참조해 courseIds FK 검증.
@Module({
  controllers: [RoadmapsController],
  providers: [RoadmapsService],
  exports: [RoadmapsService],
})
export class RoadmapsModule {}
