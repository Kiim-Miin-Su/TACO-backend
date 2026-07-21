import { IsOptional, IsString, MaxLength } from 'class-validator';
import { TEXT } from '../../../common/validation-limits'; // [보안] 자유 텍스트 상한 단일 소스

// 가입 승인 사유. 요청 역할은 가입 시 확정하며 승인 API에서 변경할 수 없다
// (전역 ValidationPipe forbidNonWhitelisted로 role 주입을 400 처리).
export class ApproveDto {
  @IsOptional() @IsString() @MaxLength(TEXT.memo)
  reason?: string;
}
