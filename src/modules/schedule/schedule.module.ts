import { Module } from '@nestjs/common';
import { RoomsModule } from '../rooms/rooms.module';
import { AvailabilityModule } from '../availability/availability.module';
import { ScheduleService } from './schedule.service';
import { ScheduleController } from './schedule.controller';

@Module({
  imports: [RoomsModule, AvailabilityModule], // 강의실 이름 join + 불가시간 충돌
  controllers: [ScheduleController],
  providers: [ScheduleService],
  exports: [ScheduleService],
})
export class ScheduleModule {}
