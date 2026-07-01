import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

// POST /reports/:id/approve — 관리자 승인
export class ApproveReportDto {
  @ApiPropertyOptional({ example: 7, description: '승인 처리자(users.id). 미지정 시 서버가 채움' })
  @IsOptional()
  @IsInt()
  approvedBy?: number;
}

// POST /reports/:id/reject — 관리자 반려(사유 보존)
export class RejectReportDto {
  @ApiPropertyOptional({ example: '진도 내용 보완 필요', description: '반려 사유(강사에게 표시)' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
