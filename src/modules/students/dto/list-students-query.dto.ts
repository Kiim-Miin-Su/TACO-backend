import { IsIn, IsOptional } from 'class-validator';

export class ListStudentsQueryDto {
  @IsOptional()
  @IsIn(['true', 'false'])
  includeInactive?: 'true' | 'false';
}
