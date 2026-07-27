// [TBO-19 Sprint4] /api/instructor-contracts — 강사 계약 조회(계약 관리 대시보드용).
//  계약 시급 등 민감 정보 → 조회도 ADMIN_ROLES(manager 이상)로 제한.
import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiOkResponse } from '@nestjs/swagger';
import { InstructorContractsService } from './instructor-contracts.service';
import { RolesGuard } from '../auth/roles.guard';
import { RequireCapabilities } from '../auth/roles.decorator';

@ApiTags('instructor-contracts')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@RequireCapabilities('finance.access')
@Controller('instructor-contracts')
export class InstructorContractsController {
  constructor(private readonly contracts: InstructorContractsService) {}

  @Get()
  @ApiOperation({ summary: '강사 계약 목록(InstructorContract[]) — 계약 시수·시급·기간 [대표]' })
  @ApiOkResponse({ description: 'InstructorContract[] — instructorId·monthlyHours·hourlyRate·periodStart·active' })
  findAll() {
    return this.contracts.findAll();
  }
}
