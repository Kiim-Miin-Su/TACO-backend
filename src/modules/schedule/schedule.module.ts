import { Module } from '@nestjs/common';
import { RoomsModule } from '../rooms/rooms.module';
import { AvailabilityModule } from '../availability/availability.module';
import { ScheduleService } from './schedule.service';
import { ScheduleController } from './schedule.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [RoomsModule, AvailabilityModule, AuthModule], // join·충돌 + RolesGuard(AuthService)
  controllers: [ScheduleController],
  providers: [ScheduleService],
  exports: [ScheduleService],
})
export class ScheduleModule {}
