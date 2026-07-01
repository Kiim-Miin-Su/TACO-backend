import { Module } from '@nestjs/common';
import { CounselService } from './counsel.service';
import { CounselController } from './counsel.controller';

@Module({
  controllers: [CounselController],
  providers: [CounselService],
  exports: [CounselService],
})
export class CounselModule {}
