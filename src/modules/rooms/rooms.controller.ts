import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { PositiveIntPipe } from '../../common/positive-int.pipe';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
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
  @ApiOperation({ summary: '강의실과 정원 목록 조회 [전 직원]' })
  findAll() {
    return this.rooms.listDb(); // [TBO-54 C2] DB 권위 READ
  }

  @Get(':id')
  @Roles(...STAFF_ROLES) // [보안 2026-07-03] 사내 데이터 조회 — 로그인 필수
  @ApiOperation({ summary: '강의실 단건 조회 [전 직원]' })
  findOne(@Param('id', PositiveIntPipe) id: number) {
    return this.rooms.getDb(id); // [TBO-54 C2] DB 권위 READ
  }

  @Post()
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '강의실과 정원 생성 [매니저 이상]' })
  create(@Body() dto: CreateRoomDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.rooms.create(dto, req.user?.sub);
  }

  // [B4 2026-07-16 대표 결정 ②] 강의실 수정·삭제 — 매니저 이상. 정원은 서버 충돌 정책 입력.
  @Patch(':id')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '강의실과 정원 수정 [매니저 이상]' })
  update(@Param('id', PositiveIntPipe) id: number, @Body() dto: UpdateRoomDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.rooms.update(id, dto, req.user?.sub);
  }

  @Delete(':id')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '일정 참조 확인 후 강의실 삭제 [매니저 이상]' })
  remove(@Param('id', PositiveIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    return this.rooms.remove(id, req.user?.sub);
  }
}
