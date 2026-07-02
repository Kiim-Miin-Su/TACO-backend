import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { EnrollmentsService } from './enrollments.service';
import { CreateEnrollmentDto } from './dto/create-enrollment.dto';

@Controller('enrollments')
export class EnrollmentsController {
  constructor(private readonly enrollments: EnrollmentsService) {}

  @Get()
  findAll(@Query('studentId') studentId?: string) {
    if (studentId) return this.enrollments.findByStudent(Number(studentId));
    return this.enrollments.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.enrollments.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateEnrollmentDto) {
    return this.enrollments.create(dto);
  }
}
