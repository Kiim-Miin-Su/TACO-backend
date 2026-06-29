import { Module } from '@nestjs/common';
import { RoomsModule } from '../rooms/rooms.module';
import { ScheduleService } from './schedule.service';
import { ScheduleController } from './schedule.controller';

@Module({
  imports: [RoomsModule], // 강의실 이름 join
  controllers: [ScheduleController],
  providers: [ScheduleService],
  exports: [ScheduleService],
})
export class ScheduleModule {}
