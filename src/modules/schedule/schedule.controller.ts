import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { ScheduleService } from './schedule.service';
import { UpdateScheduleDto } from './dto/update-schedule.dto';
import { CreateScheduleDto } from './dto/create-schedule.dto';

@ApiTags('scheduling')
@Controller('schedule')
export class ScheduleController {
  constructor(private readonly schedule: ScheduleService) {}

  // GET /api/schedule?from=YYYY-MM-DD&to=YYYY-MM-DD&instructorId=&roomId=&studentId=
  @Get()
  @ApiOperation({ summary: '스케줄 조회(기간·강사·강의실·학생 필터). studentId는 학생 활성 수강 코스의 세션만.' })
  @ApiQuery({ name: 'from', required: false }) @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'instructorId', required: false }) @ApiQuery({ name: 'roomId', required: false })
  @ApiQuery({ name: 'studentId', required: false, description: '학생 코호트(enrollment status≠drop) 역추적' })
  list(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('instructorId') instructorId?: string,
    @Query('roomId') roomId?: string,
    @Query('studentId') studentId?: string,
  ) {
    return this.schedule.list({
      from,
      to,
      instructorId: instructorId ? Number(instructorId) : undefined,
      roomId: roomId ? Number(roomId) : undefined,
      studentId: studentId ? Number(studentId) : undefined,
    });
  }

  // GET /api/schedule/resources — 자원 피커(강사·강의실·학생·코스)
  @Get('resources')
  @ApiOperation({ summary: '자원 피커 — 강사·강의실·학생·코스 옵션(FK 정렬). 좌측 레일·배정 폼용.' })
  resources() {
    return this.schedule.resources();
  }

  // 충돌 드라이런(생성·이동 전 검사). body: {sessionDate,startTime,durationMinutes|endTime,instructorId?,roomId?,ignoreSessionId?}
  @Post('conflicts')
  conflicts(@Body() body: {
    sessionDate: string; startTime: string; endTime?: string; durationMinutes?: number;
    instructorId?: number; roomId?: number; ignoreSessionId?: number;
  }) {
    return this.schedule.checkConflicts(body);
  }

  // POST /api/schedule — 세션 생성(추천→배정·수동 추가). 충돌 시 409(force=true면 적용).
  @Post()
  @ApiOperation({ summary: '세션 생성(추천→배정·수동). FK 검증 + 충돌 검사(409 / force=true 강제).' })
  create(@Body() dto: CreateScheduleDto) {
    return this.schedule.create(dto);
  }

  // 이동·리사이즈·상세편집. 충돌 시 409 {message, conflicts} (force=true면 적용).
  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateScheduleDto) {
    return this.schedule.update(id, dto);
  }
}
