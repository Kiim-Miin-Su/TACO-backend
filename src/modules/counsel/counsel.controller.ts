import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiOkResponse } from '@nestjs/swagger';
import { CounselService } from './counsel.service';

@ApiTags('counsel')
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
}
