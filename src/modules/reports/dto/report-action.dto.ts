import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

// POST /reports/:id/approve — 관리자 승인.
// [TBO-79 C2] `approvedBy`(클라이언트 지정 actor)를 제거했다. 선언돼 있는 한 whitelist를 통과하고
//  audit_log.actorId까지 도달하는 actor 위조 채널이었다. actor는 토큰(req.user.sub)만 권위다.
//  본문 없는 DTO를 **일부러 남겨둔다** — forbidNonWhitelisted가 actor 필드 재유입을 400으로 막는다.
//  여기에 필드를 추가하지 말 것.
export class ApproveReportDto {}

// POST /reports/:id/reject — 관리자 반려(사유 보존)
export class RejectReportDto {
  @ApiPropertyOptional({ example: '진도 내용 보완 필요', description: '반려 사유(강사에게 표시)' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
