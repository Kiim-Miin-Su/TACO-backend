import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { CreatePaymentDto } from './dto/create-payment.dto';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  findAll() {
    return this.payments.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.payments.findOne(id);
  }

  @Post()
  create(@Body() dto: CreatePaymentDto) {
    return this.payments.create(dto);
  }

  @Post(':id/pay')
  markPaid(@Param('id', ParseIntPipe) id: number) {
    return this.payments.markPaid(id);
  }
}
