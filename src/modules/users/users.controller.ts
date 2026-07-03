import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { UsersService } from './users.service';
import { RolesGuard } from '../auth/roles.guard';
import { Roles, STAFF_ROLES } from '../auth/roles.decorator';

@UseGuards(RolesGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  // 학생/학부모 web id 존재 확인 (등록 폼 "확인하기")
  @Get('exists')
  exists(@Query('webId') webId?: string) {
    if (!webId?.trim()) throw new BadRequestException('webId required');
    return this.users.checkWebId(webId);
  }

  @Get()
  @Roles(...STAFF_ROLES) // [보안 2026-07-03] 사내 데이터 조회 — 로그인 필수
  list() {
    return this.users.findAll();
  }
}
