import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { PositiveIntPipe } from '../../common/positive-int.pipe';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { JwtClaims } from '../auth/auth.service';
import { ADMIN_ROLES, Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SuperAdminGuard } from '../auth/super-admin.guard';
import { CreateInstructorDto } from './dto/create-instructor.dto';
import { UpdateInstructorDto } from './dto/update-instructor.dto';
import { InstructorHrService } from './instructor-hr.service'; // [TBO-68 C3]
import { SignupApprovalService } from './signup-approval.service'; // [TBO-68 C3]

@ApiTags('instructors')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('instructors')
export class InstructorsController {
  constructor(
    private readonly hr: InstructorHrService, // [TBO-68 C3] HR aggregate CRUD
    private readonly signupApproval: SignupApprovalService, // 직접 등록(승인 기계 공유)
  ) {}

  private actorOf(req: Request & { user?: JwtClaims }): number {
    if (typeof req.user?.sub !== 'number') throw new UnauthorizedException('인증 정보가 없습니다.');
    return req.user.sub;
  }

  @Get()
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '활성 강사 aggregate 목록(계정+프로필+기본 페이+Kinder). 관리자 이상.' })
  list() {
    return this.hr.listInstructors();
  }

  @Get(':id')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '강사 aggregate 상세. 관리자 이상.' })
  detail(@Param('id', PositiveIntPipe) id: number) {
    return this.hr.getInstructor(id);
  }

  @Post()
  @UseGuards(SuperAdminGuard)
  @ApiOperation({ summary: '강사 직접 생성. 대표 전용, users+profile+audit 원자 처리.' })
  async create(@Body() dto: CreateInstructorDto, @Req() req: Request & { user?: JwtClaims }) {
    const created = await this.signupApproval.provisionInstructor({ ...dto, role: 'instructor' }, this.actorOf(req));
    return this.hr.getInstructor(created.id);
  }

  @Patch(':id')
  @UseGuards(SuperAdminGuard)
  @ApiOperation({ summary: '강사 프로필·기본 페이·Kinder 수정. 대표 전용, audit 기록.' })
  update(@Param('id', PositiveIntPipe) id: number, @Body() dto: UpdateInstructorDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.hr.updateInstructor(id, this.actorOf(req), dto);
  }

  @Delete(':id')
  @UseGuards(SuperAdminGuard)
  @ApiOperation({ summary: '강사 soft delete. 대표 전용, 활성 수업·스케줄·계약은 409.' })
  remove(@Param('id', PositiveIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    return this.hr.removeInstructor(id, this.actorOf(req));
  }
}
