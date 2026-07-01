import { Module } from '@nestjs/common';
import { ParentsService } from './parents.service';
import { ParentsController } from './parents.controller';

// [참조/처리] people 도메인(무가드). 서비스가 students 컬렉션을 참조해 studentId FK 검증.
@Module({
  controllers: [ParentsController],
  providers: [ParentsService],
  exports: [ParentsService],
})
export class ParentsModule {}
