import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';

export class CreateProfileChangeRequestDto {
  @ApiPropertyOptional({ example: '박지훈', minLength: 1, maxLength: 50 })
  @ValidateIf((_object, value) => value !== undefined)
  @IsString() @MinLength(1) @MaxLength(50)
  name?: string;

  @ApiPropertyOptional({ example: '+82-10-1234-5678', nullable: true, maxLength: 20 })
  @IsOptional() @IsString() @MaxLength(20)
  phone?: string | null;

  @ApiPropertyOptional({ example: 'KR', nullable: true, description: '국가/권역 코드(예: KR, US-W)' })
  @IsOptional() @IsString() @Matches(/^[A-Za-z][A-Za-z0-9-]{1,7}$/)
  countryCode?: string | null;

  @ApiPropertyOptional({ example: 'Asia/Seoul', nullable: true, maxLength: 64 })
  @IsOptional() @IsString() @MaxLength(64)
  timeZone?: string | null;

  @ApiProperty({ example: '업무 연락처가 변경되었습니다.', minLength: 5, maxLength: 500 })
  @IsString() @MinLength(5) @MaxLength(500)
  reason!: string;
}
