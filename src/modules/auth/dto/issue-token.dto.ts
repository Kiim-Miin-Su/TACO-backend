import { ArrayNotEmpty, IsArray, IsInt, IsString } from 'class-validator';

// DTO는 class로 둡니다(런타임 검증 메타데이터 필요).
// 데코레이터가 없으면 ValidationPipe(whitelist)가 필드를 제거하므로 반드시 명시합니다.
export class IssueTokenDto {
  @IsInt()
  sub!: number;

  @IsString()
  name!: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  roles!: string[];
}
