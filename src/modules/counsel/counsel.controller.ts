import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiOkResponse, ApiCreatedResponse, ApiBearerAuth } from '@nestjs/swagger';
import { CounselService } from './counsel.service';
import { CreateCounselDto } from './dto/create-counsel.dto';
import { UpdateCounselDto } from './dto/update-counsel.dto';
import { CreateCounselRoundDto } from './dto/create-round.dto';
import { RolesGuard } from '../auth/roles.guard';
import { Roles, STAFF_ROLES } from '../auth/roles.decorator';

// [참조/처리] /api/counsel — 읽기는 공개, 쓰기(@Roles STAFF)는 로그인 필수(상담 담당자).
//  폼 생성/수정 + 회차 추가. 관심 과목/코스 FK·부모 폼 FK를 서비스가 검증.
@ApiTags('counsel')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('counsel')
export class CounselController {
  constructor(private readonly counsel: CounselService) {}

  @Get()
  @ApiOperation({ summary: '상담 접수 목록(CounselForm[])' })
  @ApiOkResponse({ description: 'CounselForm[] — 신청자·상태·관심 과목/코스·다음 상담일 등' })
  findForms() {
    return this.counsel.findAllForms();
  }

  @Get('rounds')
  @ApiOperation({ summary: '상담 회차 목록(CounselRound[]). counselFormId로 필터.' })
  @ApiQuery({ name: 'counselFormId', required: false })
  @ApiOkResponse({ description: 'CounselRound[] — 회차·요약·결과·다음 액션' })
  findRounds(@Query('counselFormId') counselFormId?: string) {
    return this.counsel.findAllRounds(counselFormId ? Number(counselFormId) : undefined);
  }

  @Post()
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '상담 접수 생성 — status=requested' })
  @ApiCreatedResponse({ description: '생성된 CounselForm' })
  createForm(@Body() dto: CreateCounselDto) {
    return this.counsel.createForm(dto);
  }

  @Patch(':id')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '상담 폼 수정(상태 전환·담당자·관심사)' })
  @ApiOkResponse({ description: '수정된 CounselForm' })
  updateForm(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateCounselDto) {
    return this.counsel.updateForm(id, dto);
  }

  @Post(':id/rounds')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '상담 회차 추가 — roundNo 자동, 폼 nextContactAt 동기화' })
  @ApiCreatedResponse({ description: '생성된 CounselRound' })
  createRound(@Param('id', ParseIntPipe) id: number, @Body() dto: CreateCounselRoundDto) {
    return this.counsel.createRound(id, dto);
  }
}
