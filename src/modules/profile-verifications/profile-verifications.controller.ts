// [TBO-29B-4 §6] 연락처 재인증 API — 전역 RolesGuard(default-auth) 아래 로그인 필수.
//  ⚠ must_change_password 계정은 전역 가드가 차단(자격증명 회복 화이트리스트에 미포함 — 의도:
//  임시 자격증명 상태에서는 연락처 변경보다 자격증명 교체가 선행).
import { Body, Controller, Param, Post, Req, UnauthorizedException } from '@nestjs/common';
import { PositiveIntPipe } from '../../common/positive-int.pipe';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Roles } from '../auth/roles.decorator';
import { STAFF_ROLES } from '../auth/role-policy';
import type { JwtClaims } from '../auth/auth.service';
import { ProfileVerificationsService } from './profile-verifications.service';
import { CreateProfileVerificationDto } from './dto/create-profile-verification.dto';
import { ConfirmProfileVerificationDto } from './dto/confirm-profile-verification.dto';
import { ProfileVerificationResponseDto } from './dto/profile-verification-response.dto';

@ApiTags('profile-verifications')
@ApiBearerAuth()
@Controller('profile-verifications')
export class ProfileVerificationsController {
  constructor(private readonly verifications: ProfileVerificationsService) {}

  @Post()
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '연락처 인증 발송 — 현재 비밀번호 재확인 + 채널(email/sms) + 대상. 응답은 masked만.' })
  create(@Body() dto: CreateProfileVerificationDto, @Req() req: Request & { user?: JwtClaims }): Promise<ProfileVerificationResponseDto> {
    return this.verifications.create(this.actorOf(req), dto);
  }

  @Post(':id/confirm')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '인증 코드 확인 — 실패 5회 잠금(400 일반화 메시지), 성공 시 verified.' })
  confirm(
    @Param('id', PositiveIntPipe) id: number,
    @Body() dto: ConfirmProfileVerificationDto,
    @Req() req: Request & { user?: JwtClaims },
  ): Promise<ProfileVerificationResponseDto> {
    return this.verifications.confirm(this.actorOf(req), id, dto.code);
  }

  @Post(':id/resend')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '인증 코드 재전송 — cooldown 60초·최대 5회, 만료 10분 갱신.' })
  resend(@Param('id', PositiveIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }): Promise<ProfileVerificationResponseDto> {
    return this.verifications.resend(this.actorOf(req), id);
  }

  private actorOf(req: Request & { user?: JwtClaims }): number {
    const sub = req.user?.sub;
    if (typeof sub !== 'number') throw new UnauthorizedException('인증 정보가 없습니다.');
    return sub;
  }
}
