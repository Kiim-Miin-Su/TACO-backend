import { Body, Controller, Delete, Get, Param, ParseArrayPipe, ParseIntPipe, Post, Put, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { JwtClaims } from '../auth/auth.service';
import { ADMIN_ROLES, Roles, STAFF_ROLES } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { StudentInterestDto } from './dto/student-interest.dto';
import { StudentInterestsService } from './student-interests.service';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('student-interests')
@UseGuards(RolesGuard)
@Controller('students/:studentId/interests')
export class StudentInterestsController {
  constructor(private readonly interests: StudentInterestsService) {}

  @Get()
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '학생 관심 희망 수업 목록 조회 [전 직원]' })
  list(@Param('studentId', ParseIntPipe) studentId: number) {
    return this.interests.listByStudentDb(studentId); // [TBO-56 C2b] DB 권위 READ
  }

  @Put()
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '학생 관심 희망 수업 전체 교체 [매니저 이상]' })
  replace(
    @Param('studentId', ParseIntPipe) studentId: number,
    @Body(new ParseArrayPipe({ items: StudentInterestDto })) body: StudentInterestDto[],
    @Req() req: Request & { user?: JwtClaims },
  ) {
    return this.interests.replace(studentId, body, this.actor(req));
  }

  @Post()
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '학생 관심 희망 수업 추가 [매니저 이상]' })
  add(@Param('studentId', ParseIntPipe) studentId: number, @Body() body: StudentInterestDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.interests.add(studentId, body, this.actor(req));
  }

  @Delete(':interestId')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '학생 관심 희망 수업 삭제 [매니저 이상]' })
  remove(
    @Param('studentId', ParseIntPipe) studentId: number,
    @Param('interestId', ParseIntPipe) interestId: number,
    @Req() req: Request & { user?: JwtClaims },
  ) {
    return this.interests.remove(studentId, interestId, this.actor(req));
  }

  private actor(req: Request & { user?: JwtClaims }): number {
    if (typeof req.user?.sub !== 'number') throw new UnauthorizedException('인증 정보가 없습니다.');
    return req.user.sub;
  }
}
