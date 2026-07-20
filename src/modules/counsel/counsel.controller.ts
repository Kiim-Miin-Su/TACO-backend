import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiOkResponse, ApiCreatedResponse, ApiBearerAuth } from '@nestjs/swagger';
import type { Request } from 'express';
import { CounselService } from './counsel.service';
import { CreateCounselDto } from './dto/create-counsel.dto';
import { UpdateCounselDto } from './dto/update-counsel.dto';
import { CreateCounselRoundDto } from './dto/create-round.dto';
import { RolesGuard } from '../auth/roles.guard';
import { Roles, STAFF_ROLES } from '../auth/roles.decorator';
import type { JwtClaims } from '../auth/auth.service';

// [참조/처리] /api/counsel — 읽기·쓰기는 모두 로그인 직원 전용.
//  폼 생성/수정 + 회차 추가. 관심 과목/코스 FK·부모 폼 FK를 서비스가 검증.
@ApiTags('counsel')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('counsel')
export class CounselController {
  constructor(private readonly counsel: CounselService) {}

  @Get()
  @Roles(...STAFF_ROLES) // [보안 2026-07-03] 사내 데이터 조회 — 로그인 필수
  @ApiOperation({ summary: '상담 접수 목록(CounselForm[])' })
  @ApiOkResponse({ description: 'CounselForm[] — 신청자·상태·관심 과목/코스·다음 상담일 등' })
  findForms() {
    return this.counsel.findAllForms();
  }

  @Get('rounds')
  @Roles(...STAFF_ROLES) // [보안 2026-07-03] 사내 데이터 조회 — 로그인 필수
  @ApiOperation({ summary: '상담 회차 목록(CounselRound[]). counselFormId로 필터.' })
  @ApiQuery({ name: 'counselFormId', required: false })
  @ApiOkResponse({ description: 'CounselRound[] — 회차·요약·결과·다음 액션' })
  findRounds(@Query('counselFormId') counselFormId?: string) {
    return this.counsel.findAllRounds(counselFormId ? Number(counselFormId) : undefined);
  }

  // [B7 E3 2026-07-16] GET /api/counsel/:id — 상담 폼 단건(상세 화면 전량 로드 후 find 제거).
  //  없는 id=404(서비스 findForm). 정적 GET('rounds')보다 뒤에 선언(':id' 가로채기 방지).
  @Get(':id')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '상담 폼 단건(CounselForm) — 상세 화면용. 없는 id=404.' })
  @ApiOkResponse({ description: 'CounselForm' })
  findForm(@Param('id', ParseIntPipe) id: number) {
    return this.counsel.findForm(id);
  }

  @Post()
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '상담 접수 생성 — status=requested' })
  @ApiCreatedResponse({ description: '생성된 CounselForm' })
  createForm(@Body() dto: CreateCounselDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.counsel.createForm(dto, req.user?.sub);
  }

  @Patch(':id')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '상담 폼 수정(상태 전환·담당자·관심사)' })
  @ApiOkResponse({ description: '수정된 CounselForm' })
  updateForm(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateCounselDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.counsel.updateForm(id, dto, req.user?.sub);
  }

  @Delete(':id')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '상담 폼과 회차 soft delete — 감사 스냅샷 포함' })
  removeForm(@Param('id', ParseIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    return this.counsel.removeForm(id, req.user!.sub);
  }

  @Post(':id/rounds')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '상담 회차 추가 — roundNo 자동, 폼 nextContactAt 동기화' })
  @ApiCreatedResponse({ description: '생성된 CounselRound' })
  createRound(@Param('id', ParseIntPipe) id: number, @Body() dto: CreateCounselRoundDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.counsel.createRound(id, dto, req.user?.sub);
  }
}
