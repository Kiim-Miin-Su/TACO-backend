import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService, JwtClaims } from './auth.service';
import { IssueTokenDto } from './dto/issue-token.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // 데모용 토큰 발급 (실제 로그인 로직은 추후 users 검증과 연결)
  @Post('token')
  issue(@Body() dto: IssueTokenDto): { accessToken: string } {
    const claims: JwtClaims = {
      sub: dto.sub,
      name: dto.name,
      roles: dto.roles ?? [],
    };
    return { accessToken: this.auth.sign(claims) };
  }

  // Authorization: Bearer <token> 검증
  @Get('me')
  me(@Headers('authorization') authorization?: string) {
    const token = authorization?.replace(/^Bearer\s+/i, '');
    if (!token) throw new UnauthorizedException('Missing bearer token');
    return this.auth.verify(token);
  }
}
