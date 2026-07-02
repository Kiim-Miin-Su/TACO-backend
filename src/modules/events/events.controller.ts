// [참조/처리] /api/events REST. RolesGuard 적용:
//  - GET: 로그인만 필요(목록) → EventsService.findAll(시작일 오름차순).
//  - POST: @Roles(ADMIN_ROLES) 관리자만 → CreateEventDto 검증(ValidationPipe) → 서비스가 end≥start 재검증(400).
//  프론트 api.events가 이 라우트를 호출, EventsView 발행 폼이 POST 후 events 쿼리 무효화→하이드레이트.
import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiOkResponse, ApiCreatedResponse } from '@nestjs/swagger';
import { EventsService } from './events.service';
import { CreateEventDto } from './dto/create-event.dto';
import { RolesGuard } from '../auth/roles.guard';
import { Roles, ADMIN_ROLES } from '../auth/roles.decorator';

@ApiTags('events')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get()
  @ApiOperation({ summary: '학원 이벤트/공지 목록(AcademyEvent[]) — 캘린더 표시(시작일 오름차순)' })
  @ApiOkResponse({ description: 'AcademyEvent[] — title·type·priority·startDate·endDate·allDay·memo' })
  findAll() {
    return this.events.findAll();
  }

  // 발행은 관리자만(RolesGuard). endDate ≥ startDate 검증(400).
  @Post()
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '학원 이벤트 발행(관리자) — 캘린더 구간 유효성 검증' })
  @ApiCreatedResponse({ description: '생성된 AcademyEvent' })
  create(@Body() dto: CreateEventDto) {
    return this.events.create(dto);
  }
}
