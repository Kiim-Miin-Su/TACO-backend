import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PositiveIntPipe } from '../../common/positive-int.pipe';
import type { Request } from 'express';
import type { JwtClaims } from '../auth/auth.service';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PaymentsService } from './payments.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { UpdatePaymentDto } from './dto/update-payment.dto';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { SudoGuard } from '../auth/sudo.guard'; // [TBO-59 C3-2]

// [참조/처리] /api/payments — 결제·수납은 돈 관련 정보라 대표(CEO)만 조회/처리한다.
@ApiTags('payments')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  @Roles('super_admin') // [TBO-21 RBAC] 결제·수납은 돈 관련 정보 → 대표 전용
  @ApiOperation({ summary: '결제·수납 목록 [대표]' })
  findAll() {
    return this.payments.listDb(); // [TBO-54 C2] DB 권위 READ
  }

  @Get(':id')
  @Roles('super_admin')
  @ApiOperation({ summary: '결제·수납 상세 [대표]' })
  findOne(@Param('id', PositiveIntPipe) id: number) {
    return this.payments.getDb(id); // [TBO-54 C2] DB 권위 READ
  }

  @Post()
  @Roles('super_admin')
  @ApiOperation({ summary: '신규 청구 생성 [대표]' })
  create(@Body() dto: CreatePaymentDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.payments.create(dto, req.user?.sub);
  }

  @Patch(':id')
  @Roles('super_admin')
  @ApiOperation({ summary: '청구 금액·수단·기한 정정 [대표]' })
  update(@Param('id', PositiveIntPipe) id: number, @Body() dto: UpdatePaymentDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.payments.update(id, dto, req.user?.sub);
  }

  @Post(':id/refund')
  @UseGuards(SudoGuard) // [TBO-59 C3-2] 환불(원장 출금) = sudo 재인증
  @Roles('super_admin')
  @ApiOperation({ summary: '수납 환불 + 원장 역방향 출금 기록(재인증 필수) [대표]. cookie 세션은 reauth 후 10분 내만 허용(403 SUDO_REQUIRED).' })
  refund(@Param('id', PositiveIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    return this.payments.refund(id, req.user?.sub);
  }

  @Post(':id/pay')
  @Roles('super_admin')
  @ApiOperation({ summary: '수납 완료 처리 + 통합 원장 입금 기록 [대표]' })
  markPaid(@Param('id', PositiveIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    return this.payments.markPaid(id, req.user?.sub);
  }
}
