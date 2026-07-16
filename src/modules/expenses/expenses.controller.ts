import { Body, Controller, Get, Param, ParseIntPipe, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { JwtClaims } from '../auth/auth.service';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { ExpensesService } from './expenses.service';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { RejectExpenseDto } from './dto/reject-expense.dto';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

@ApiTags('expenses')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('expenses')
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get()
  @Roles('super_admin') // [TBO-21 RBAC] 지출은 돈 관련 정보 → 대표 전용
  @ApiOperation({ summary: '지출 목록 [대표]' })
  findAll() {
    return this.expenses.findAll();
  }

  @Get(':id')
  @Roles('super_admin')
  @ApiOperation({ summary: '지출 상세 [대표]' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.expenses.findOne(id);
  }

  @Post()
  @Roles('super_admin')
  @ApiOperation({ summary: '지출 요청 생성 [대표]' })
  create(@Body() dto: CreateExpenseDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.expenses.create(dto, req.user?.sub);
  }

  // 대표 승인/반려 — TBO-21: 지출 승인권은 super_admin 전용.
  @Post(':id/approve')
  @Roles('super_admin')
  @ApiOperation({ summary: '지출 승인 + 통합 원장 출금 기록 [대표]' })
  approve(@Param('id', ParseIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    return this.expenses.approve(id, req.user?.sub);
  }

  @Post(':id/reject')
  @Roles('super_admin')
  @ApiOperation({ summary: '지출 반려(사유 필수) [대표]' })
  reject(@Param('id', ParseIntPipe) id: number, @Body() body: RejectExpenseDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.expenses.reject(id, body.reason, req.user?.sub); // [Q2] 사유 필수(DTO 강제)
  }
}
