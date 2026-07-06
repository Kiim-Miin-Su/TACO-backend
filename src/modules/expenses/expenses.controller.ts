import { Body, Controller, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ExpensesService } from './expenses.service';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { RejectExpenseDto } from './dto/reject-expense.dto';
import { RolesGuard } from '../auth/roles.guard';
import { Roles, ADMIN_ROLES, STAFF_ROLES } from '../auth/roles.decorator';

@ApiTags('expenses')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('expenses')
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get()
  @Roles(...STAFF_ROLES) // [통신 감사 2026-07-03 H1] 재무 정보 비로그인 노출 차단
  findAll() {
    return this.expenses.findAll();
  }

  @Get(':id')
  @Roles(...STAFF_ROLES) // [통신 감사 2026-07-03 H1] 재무 정보 비로그인 노출 차단
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.expenses.findOne(id);
  }

  @Post()
  @Roles(...STAFF_ROLES)
  create(@Body() dto: CreateExpenseDto) {
    return this.expenses.create(dto);
  }

  // 관리자 승인/반려 — RolesGuard로 super_admin/manager/admin만 허용.
  @Post(':id/approve')
  @Roles(...ADMIN_ROLES)
  approve(@Param('id', ParseIntPipe) id: number) {
    return this.expenses.approve(id);
  }

  @Post(':id/reject')
  @Roles(...ADMIN_ROLES)
  reject(@Param('id', ParseIntPipe) id: number, @Body() body: RejectExpenseDto) {
    return this.expenses.reject(id, body.reason); // [Q2] 사유 필수(DTO 강제)
  }
}
