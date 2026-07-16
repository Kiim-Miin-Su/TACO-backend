import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RoomsService } from './rooms.service';
import { CreateRoomDto } from './dto/create-room.dto';
import { UpdateRoomDto } from './dto/update-room.dto';
import { RolesGuard } from '../auth/roles.guard';
import { Roles, ADMIN_ROLES, STAFF_ROLES } from '../auth/roles.decorator';
import type { JwtClaims } from '../auth/auth.service';

@ApiTags('rooms')
@UseGuards(RolesGuard)
@Controller('rooms')
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}

  @Get()
  @Roles(...STAFF_ROLES) // [보안 2026-07-03] 사내 데이터 조회 — 로그인 필수
  findAll() {
    return this.rooms.findAll();
  }

  @Get(':id')
  @Roles(...STAFF_ROLES) // [보안 2026-07-03] 사내 데이터 조회 — 로그인 필수
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.rooms.findOne(id);
  }

  @Post()
  @Roles(...ADMIN_ROLES)
  create(@Body() dto: CreateRoomDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.rooms.create(dto, req.user?.sub);
  }

  // [B4 2026-07-16 대표 결정 ②] 강의실 수정·삭제 — 매니저 이상. 정원은 서버 충돌 정책 입력.
  @Patch(':id')
  @Roles(...ADMIN_ROLES)
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateRoomDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.rooms.update(id, dto, req.user?.sub);
  }

  @Delete(':id')
  @Roles(...ADMIN_ROLES)
  remove(@Param('id', ParseIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    return this.rooms.remove(id, req.user?.sub);
  }
}
