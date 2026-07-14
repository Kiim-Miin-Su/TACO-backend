import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class RejectProfileChangeRequestDto {
  @ApiProperty({ example: '전화번호 확인 후 다시 요청해 주세요.', minLength: 5, maxLength: 500 })
  @IsString() @MinLength(5) @MaxLength(500)
  reason!: string;
}
