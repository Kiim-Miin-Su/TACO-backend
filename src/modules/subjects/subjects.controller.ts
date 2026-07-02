import { Body, Controller, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SubjectsService } from './subjects.service';
import { CreateSubjectDto } from './dto/create-subject.dto';
import { RolesGuard } from '../auth/roles.guard';
import { Roles, ADMIN_ROLES } from '../auth/roles.decorator';

@ApiTags('subjects')
@UseGuards(RolesGuard)
@Controller('subjects')
export class SubjectsController {
  constructor(private readonly subjects: SubjectsService) {}

  @Get()
  findAll() {
    return this.subjects.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.subjects.findOne(id);
  }

  @Post()
  @Roles(...ADMIN_ROLES)
  create(@Body() dto: CreateSubjectDto) {
    return this.subjects.create(dto);
  }
}
