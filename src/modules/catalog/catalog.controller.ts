// [E0.5 ④] /api/catalog — 참조 데이터 조회(읽기 전용). 국가·시간대 토글 옵션의 단일 소스.
import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiOkResponse } from '@nestjs/swagger';
import { Roles, STAFF_ROLES } from '../auth/roles.decorator';
import { CountriesService } from './countries.service';

@ApiTags('catalog')
@ApiBearerAuth()
@Controller('catalog')
export class CatalogController {
  constructor(private readonly countries: CountriesService) {}

  @Get('countries')
  @Roles(...STAFF_ROLES) // 로그인 필수 — 프로필 변경 모달(전 직원)이 사용
  @ApiOperation({ summary: '국가·시간대 카탈로그(Country[]) — 프로필 국가/시간대 토글 옵션(sort_order 순)' })
  @ApiOkResponse({ description: 'Country[] — code·nameKo·nameEn·timeZone·flag·sortOrder' })
  findCountries() {
    return this.countries.findAll();
  }
}
