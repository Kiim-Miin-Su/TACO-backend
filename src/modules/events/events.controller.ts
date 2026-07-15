// [참조/처리] /api/events REST. RolesGuard 적용:
//  - GET: 로그인만 필요(목록) → EventsService.findAll(시작일 오름차순).
//  - POST: @Roles(ADMIN_ROLES) 관리자만 → CreateEventDto 검증(ValidationPipe) → 서비스가 end≥start 재검증(400).
//  프론트 api.events가 이 라우트를 호출, EventsView 발행 폼이 POST 후 events 쿼리 무효화→하이드레이트.
import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiOkResponse, ApiCreatedResponse } from '@nestjs/swagger';
import type { Request } from 'express';
import { EventsService } from './events.service';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { RolesGuard } from '../auth/roles.guard';
import { Roles, ADMIN_ROLES, STAFF_ROLES } from '../auth/roles.decorator';
import type { JwtClaims } from '../auth/auth.service';

@ApiTags('events')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get()
  @Roles(...STAFF_ROLES) // [보안 2026-07-03] 사내 데이터 조회 — 로그인 필수
  @ApiOperation({ summary: '학원 이벤트/공지 목록(AcademyEvent[]) — 캘린더 표시(시작일 오름차순)' })
  @ApiOkResponse({ description: 'AcademyEvent[] — title·type·priority·startDate·endDate·allDay·memo' })
  findAll() {
    return this.events.findAll();
  }

  // [TBO-29D 요구 ⑥] CUD는 매니저 이상(ADMIN_ROLES) — 조회는 강사 포함 전 직원(위 GET).
  @Post()
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '학원 이벤트 발행(매니저 이상) — 캘린더 구간 유효성 검증 + audit' })
  @ApiCreatedResponse({ description: '생성된 AcademyEvent' })
  create(@Body() dto: CreateEventDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.events.create(dto, this.actorOf(req));
  }

  @Patch(':id')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '학원 이벤트 수정(매니저 이상) — 병합 후 구간 재검증 + diff audit' })
  @ApiOkResponse({ description: '수정된 AcademyEvent' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateEventDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.events.update(id, dto, this.actorOf(req));
  }

  @Delete(':id')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '학원 이벤트 삭제(매니저 이상) — soft delete + before 스냅샷 audit' })
  @ApiOkResponse({ description: '삭제된 AcademyEvent(스냅샷)' })
  remove(@Param('id', ParseIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    return this.events.remove(id, this.actorOf(req));
  }

  private actorOf(req: Request & { user?: JwtClaims }): number {
    const sub = req.user?.sub;
    if (typeof sub !== 'number') throw new UnauthorizedException('인증 정보가 없습니다.');
    return sub;
  }
}
