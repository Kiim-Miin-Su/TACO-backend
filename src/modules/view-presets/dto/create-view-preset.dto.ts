import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Matches, MaxLength,
} from 'class-validator';
import type { CreateViewPresetInput } from '@kms545487/contracts';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CC_RE = /^[A-Z]{2}(-[A-Z])?$/; // 국가 코드(US-W 같은 표시 변형 허용)

// implements 계약(단일 소스) — 필드 누락/이탈은 tsc가 잡는다.
export class CreateViewPresetDto implements CreateViewPresetInput {
  @IsString() @MaxLength(40)
  name!: string;

  @IsIn(['month', 'week', 'day'])
  view!: 'month' | 'week' | 'day';

  @IsOptional() @Matches(DATE_RE)
  periodFrom?: string;

  @IsOptional() @Matches(DATE_RE)
  periodTo?: string;

  @IsArray() @IsInt({ each: true }) @ArrayMaxSize(50)
  instructorIds!: number[];

  @IsArray() @IsInt({ each: true }) @ArrayMaxSize(50)
  studentIds!: number[];

  @IsArray() @IsInt({ each: true }) @ArrayMaxSize(50)
  roomIds!: number[];

  @IsArray() @IsString({ each: true }) @ArrayMaxSize(30)
  subjects!: string[];

  @IsArray() @IsIn(['attended', 'late', 'absence', 'makeup'], { each: true }) // lib/domain/lantiv.StatusFilter와 정합
  statuses!: string[];

  @IsBoolean()
  groupOnly!: boolean;

  @IsOptional() @IsString() @MaxLength(100)
  q?: string;

  @IsOptional() @IsIn(['subject', 'instructor', 'room', 'student'])
  colorBy?: string;

  @IsOptional() @Matches(CC_RE)
  countryCode?: string;

  @IsOptional() @Matches(CC_RE)
  paneCountryInstructor?: string;

  @IsOptional() @Matches(CC_RE)
  paneCountryStudent?: string;

  @IsOptional() @IsArray() @IsIn(['in_person', 'online'], { each: true })
  modeFilters?: string[];

  @IsOptional() @IsBoolean()
  kstFixed?: boolean;

  @IsOptional() @IsBoolean()
  compactCols?: boolean;

  @IsOptional() @IsArray() @ArrayMaxSize(12) @IsObject({ each: true })
  manualPanes?: {
    uid?: number;
    dim: 'instructor' | 'student' | 'room' | 'subject';
    ids: number[];
    countryCode?: string;
    modeFilters?: string[];
    rangeFrom?: string;
    rangeTo?: string;
    pickedDates?: string[];
  }[];
}
