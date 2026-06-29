import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ScheduleService } from './schedule.service';

@ApiTags('scheduling')
@Controller('schedule')
export class ScheduleController {
  constructor(private readonly schedule: ScheduleService) {}

  // GET /api/schedule?from=YYYY-MM-DD&to=YYYY-MM-DD&instructorId=&roomId=
  @Get()
  list(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('instructorId') instructorId?: string,
    @Query('roomId') roomId?: string,
  ) {
    return this.schedule.list({
      from,
      to,
      instructorId: instructorId ? Number(instructorId) : undefined,
      roomId: roomId ? Number(roomId) : undefined,
    });
  }
}
