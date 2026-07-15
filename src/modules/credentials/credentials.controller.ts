// [E0] PATCH /users/me/credentials — UsersController에서 이 모듈로 이동(경로·계약 동일).
//  이동 사유: 비밀번호 변경 이메일 OTP가 ProfileVerificationsService를 필요로 하는데
//  Users↔ProfileVerifications는 모듈 순환이라 제3 모듈이 오케스트레이션한다(위 service 주석).
import { Body, Controller, Patch, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import type { Request } from 'express';
import { RolesGuard } from '../auth/roles.guard';
import { Roles, STAFF_ROLES } from '../auth/roles.decorator';
import type { JwtClaims } from '../auth/auth.service';
import { ChangeCredentialsDto } from '../users/dto/change-credentials.dto';
import { CredentialAccountResponseDto } from '../users/dto/credential-account-response.dto';
import { CredentialsService } from './credentials.service';

@UseGuards(RolesGuard)
@Controller('users')
export class CredentialsController {
  constructor(private readonly credentials: CredentialsService) {}

  @Patch('me/credentials')
  @Roles(...STAFF_ROLES)
  @ApiBearerAuth()
  @ApiOperation({ summary: '내 아이디/비밀번호 변경 — 현재 비밀번호 재검증 + (평시) 본인 이메일 OTP 소비, auth_version 증가, audit 원자 tx. 아이디 변경은 승인제(강제 변경 흐름만 직접).' })
  @ApiOkResponse({ type: CredentialAccountResponseDto })
  async changeCredentials(@Body() dto: ChangeCredentialsDto, @Req() req: Request & { user?: JwtClaims }) {
    const sub = req.user?.sub;
    if (typeof sub !== 'number') throw new UnauthorizedException('인증 정보가 없습니다.');
    const account = await this.credentials.change(sub, dto);
    return {
      id: account.id,
      webId: account.webId,
      name: account.name,
      role: account.role,
      mustChangePassword: account.mustChangePassword === true,
    };
  }
}
