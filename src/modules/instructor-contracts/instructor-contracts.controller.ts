// [TBO-19 Sprint4] /api/instructor-contracts — 강사 계약 조회(계약 관리 대시보드용).
//  계약 시급 등 민감 정보 → 조회도 ADMIN_ROLES(manager 이상)로 제한.
import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiOkResponse } from '@nestjs/swagger';
import { InstructorContractsService } from './instructor-contracts.service';
import { RequireCapabilities } from '../auth/roles.decorator';
import { SudoGuard } from '../auth/sudo.guard';
import { OptionalPositiveIntPipe, PositiveIntPipe } from '../../common/positive-int.pipe';
import type { JwtClaims } from '../auth/auth.service';
import { CreateInstructorContractDto, UpdateInstructorContractDto } from './dto/instructor-contract.dto';

@ApiTags('instructor-contracts')
@ApiBearerAuth()
@RequireCapabilities('finance.access')
@Controller('instructor-contracts')
export class InstructorContractsController {
  constructor(private readonly contracts: InstructorContractsService) {}

  @Get()
  @ApiOperation({ summary: '강사 계약 목록(InstructorContract[]) — 계약 시수·시급·기간 [대표]' })
  @ApiOkResponse({ description: 'InstructorContract[] — instructorId·monthlyHours·hourlyRate·periodStart·active' })
  findAll(@Query('instructorId', OptionalPositiveIntPipe) instructorId?: number) {
    return this.contracts.findAll(instructorId);
  }

  @Get(':id')
  @ApiOperation({ summary: '강사 계약 단건 [대표]' })
  findOne(@Param('id', PositiveIntPipe) id: number) {
    return this.contracts.findOne(id);
  }

  @Post()
  @UseGuards(SudoGuard)
  @ApiOperation({ summary: '강사 기간 계약 생성, 재인증 필수 [대표]' })
  create(@Body() dto: CreateInstructorContractDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.contracts.create(dto, req.user!.sub);
  }

  @Patch(':id')
  @UseGuards(SudoGuard)
  @ApiOperation({ summary: '강사 기간 계약 수정·종료, 재인증·사유 필수 [대표]' })
  update(
    @Param('id', PositiveIntPipe) id: number,
    @Body() dto: UpdateInstructorContractDto,
    @Req() req: Request & { user?: JwtClaims },
  ) {
    return this.contracts.update(id, dto, req.user!.sub);
  }
}
