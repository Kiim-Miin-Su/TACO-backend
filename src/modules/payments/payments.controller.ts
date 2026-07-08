import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PaymentsService } from './payments.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { UpdatePaymentDto } from './dto/update-payment.dto';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

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
    return this.payments.findAll();
  }

  @Get(':id')
  @Roles('super_admin')
  @ApiOperation({ summary: '결제·수납 상세 [대표]' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.payments.findOne(id);
  }

  @Post()
  @Roles('super_admin')
  @ApiOperation({ summary: '신규 청구 생성 [대표]' })
  create(@Body() dto: CreatePaymentDto) {
    return this.payments.create(dto);
  }

  @Patch(':id')
  @Roles('super_admin')
  @ApiOperation({ summary: '청구 금액·수단·기한 정정 [대표]' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdatePaymentDto) {
    return this.payments.update(id, dto);
  }

  @Post(':id/refund')
  @Roles('super_admin')
  @ApiOperation({ summary: '수납 환불 + 원장 역방향 출금 기록 [대표]' })
  refund(@Param('id', ParseIntPipe) id: number) {
    return this.payments.refund(id);
  }

  @Post(':id/pay')
  @Roles('super_admin')
  @ApiOperation({ summary: '수납 완료 처리 + 통합 원장 입금 기록 [대표]' })
  markPaid(@Param('id', ParseIntPipe) id: number) {
    return this.payments.markPaid(id);
  }
}
