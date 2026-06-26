import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { UsersService } from './users.service';

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
  list() {
    return this.users.findAll();
  }
}
