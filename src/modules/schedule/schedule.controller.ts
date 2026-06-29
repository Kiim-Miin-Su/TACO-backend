import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ScheduleService } from './schedule.service';
import { UpdateScheduleDto } from './dto/update-schedule.dto';

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

  // 충돌 드라이런(생성·이동 전 검사). body: {sessionDate,startTime,durationMinutes|endTime,instructorId?,roomId?,ignoreSessionId?}
  @Post('conflicts')
  conflicts(@Body() body: {
    sessionDate: string; startTime: string; endTime?: string; durationMinutes?: number;
    instructorId?: number; roomId?: number; ignoreSessionId?: number;
  }) {
    return this.schedule.checkConflicts(body);
  }

  // 이동·리사이즈·상세편집. 충돌 시 409 {message, conflicts} (force=true면 적용).
  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateScheduleDto) {
    return this.schedule.update(id, dto);
  }
}
