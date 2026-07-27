import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { PositiveIntPipe } from '../../common/positive-int.pipe';
import { ApiTags, ApiOperation, ApiOkResponse, ApiCreatedResponse } from '@nestjs/swagger';
import type { Request } from 'express';
import { ParentsService } from './parents.service';
import { CreateParentDto } from './dto/create-parent.dto';
import { LinkParentDto, UpdateRelationDto } from './dto/link-parent.dto';
import { RolesGuard } from '../auth/roles.guard';
import { Roles, ADMIN_ROLES } from '../auth/roles.decorator';
import type { JwtClaims } from '../auth/auth.service';
import { UpdateParentDto } from './dto/update-parent.dto';

// [참조/처리] /api/parents REST(people 도메인 — students와 동일하게 무가드).
//  - GET /parents · GET /parents/relations(M:N). POST /parents(신규+연결) · POST /parents/link(기존 연결).
//  - PATCH /parents/relations/:id(대표 이전·납부자). 대표(primary)는 학생당 ≤1 불변으로 유지.
@ApiTags('parents')
@UseGuards(RolesGuard)
@Controller('parents')
export class ParentsController {
  constructor(private readonly parents: ParentsService) {}

  @Get()
  @Roles(...ADMIN_ROLES) // [TBO-59 C3 · P0-5] 보호자 연락처 = 관리자 전용(강사 403)
  @ApiOperation({ summary: '보호자 목록(Parent[]) — 연락처 포함이라 관리자 전용(강사 403, P0-5) [매니저 이상]' })
  @ApiOkResponse({ description: 'Parent[] — name·phone·kakaoAvailable' })
  findAll() {
    return this.parents.listDb(); // [TBO-54 C2] DB 권위 READ
  }

  @Get('relations')
  @Roles(...ADMIN_ROLES) // [TBO-59 C3 · P0-5] 보호자 연락처 = 관리자 전용(강사 403)
  @ApiOperation({ summary: '학생↔보호자 관계(ParentStudent[]) — M:N(대표/납부자) [매니저 이상]' })
  @ApiOkResponse({ description: 'ParentStudent[] — parentId·studentId·relation·isPayer·isPrimary' })
  findAllRelations() {
    return this.parents.listRelationsDb(); // [TBO-54 C2] DB 권위 READ
  }

  @Get(':id')
  @Roles(...ADMIN_ROLES) // [TBO-59 C3 · P0-5]
  @ApiOperation({ summary: '보호자 단건과 학생 연결 정보 조회 [매니저 이상]' })
  findOne(@Param('id', PositiveIntPipe) id: number) {
    return this.parents.getDb(id); // [TBO-54 C2] DB 권위 READ
  }

  @Post()
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '보호자 등록 + 학생 연결 — studentId FK 검증, 대표 불변' })
  @ApiCreatedResponse({ description: '{ parent, relation }' })
  create(@Body() dto: CreateParentDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.parents.create(dto, req.user?.sub);
  }

  @Post('link')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '기존 보호자를 학생에 연결(형제 M:N) — FK·유니크·대표 불변' })
  @ApiCreatedResponse({ description: '생성된 ParentStudent' })
  link(@Body() dto: LinkParentDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.parents.link(dto, req.user?.sub);
  }

  @Patch('relations/:id')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '관계 수정(대표 이전·납부자 변경) — 대표 지정 시 기존 대표 강등' })
  @ApiOkResponse({ description: '수정된 ParentStudent' })
  updateRelation(@Param('id', PositiveIntPipe) id: number, @Body() dto: UpdateRelationDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.parents.updateRelation(id, dto, req.user?.sub);
  }

  @Delete('relations/:id')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '학생과 보호자의 연결 관계 soft delete [매니저 이상]' })
  removeRelation(@Param('id', PositiveIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    return this.parents.removeRelation(id, this.actor(req));
  }

  @Delete('relations/:id/guardian')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '학생 연결과 미참조 보호자를 함께 soft delete [매니저 이상]' })
  removeGuardian(@Param('id', PositiveIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    return this.parents.removeGuardian(id, this.actor(req));
  }

  @Patch(':id')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '보호자 연락처·관계 정보를 수정하고 이력 기록 [매니저 이상]' })
  update(@Param('id', PositiveIntPipe) id: number, @Body() dto: UpdateParentDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.parents.update(id, dto, this.actor(req));
  }

  @Delete(':id')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '참조 무결성 확인 후 보호자 soft delete [매니저 이상]' })
  remove(@Param('id', PositiveIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    return this.parents.remove(id, this.actor(req));
  }

  private actor(req: Request & { user?: JwtClaims }): number {
    if (typeof req.user?.sub !== 'number') throw new UnauthorizedException('인증 정보가 없습니다.');
    return req.user.sub;
  }
}
