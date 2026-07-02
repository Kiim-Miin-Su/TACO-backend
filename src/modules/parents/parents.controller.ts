import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiOkResponse, ApiCreatedResponse } from '@nestjs/swagger';
import { ParentsService } from './parents.service';
import { CreateParentDto } from './dto/create-parent.dto';
import { LinkParentDto, UpdateRelationDto } from './dto/link-parent.dto';
import { RolesGuard } from '../auth/roles.guard';
import { Roles, ADMIN_ROLES } from '../auth/roles.decorator';

// [참조/처리] /api/parents REST(people 도메인 — students와 동일하게 무가드).
//  - GET /parents · GET /parents/relations(M:N). POST /parents(신규+연결) · POST /parents/link(기존 연결).
//  - PATCH /parents/relations/:id(대표 이전·납부자). 대표(primary)는 학생당 ≤1 불변으로 유지.
@ApiTags('parents')
@UseGuards(RolesGuard)
@Controller('parents')
export class ParentsController {
  constructor(private readonly parents: ParentsService) {}

  @Get()
  @ApiOperation({ summary: '보호자 목록(Parent[])' })
  @ApiOkResponse({ description: 'Parent[] — name·phone·kakaoAvailable' })
  findAll() {
    return this.parents.findAll();
  }

  @Get('relations')
  @ApiOperation({ summary: '학생↔보호자 관계(ParentStudent[]) — M:N(대표/납부자)' })
  @ApiOkResponse({ description: 'ParentStudent[] — parentId·studentId·relation·isPayer·isPrimary' })
  findAllRelations() {
    return this.parents.findAllRelations();
  }

  @Post()
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '보호자 등록 + 학생 연결 — studentId FK 검증, 대표 불변' })
  @ApiCreatedResponse({ description: '{ parent, relation }' })
  create(@Body() dto: CreateParentDto) {
    return this.parents.create(dto);
  }

  @Post('link')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '기존 보호자를 학생에 연결(형제 M:N) — FK·유니크·대표 불변' })
  @ApiCreatedResponse({ description: '생성된 ParentStudent' })
  link(@Body() dto: LinkParentDto) {
    return this.parents.link(dto);
  }

  @Patch('relations/:id')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '관계 수정(대표 이전·납부자 변경) — 대표 지정 시 기존 대표 강등' })
  @ApiOkResponse({ description: '수정된 ParentStudent' })
  updateRelation(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateRelationDto) {
    return this.parents.updateRelation(id, dto);
  }
}
