import { Body, Controller, Delete, Get, Param, ParseIntPipe, Put, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiParam, ApiOkResponse, ApiConflictResponse, ApiBadRequestResponse } from '@nestjs/swagger';
import { AvailabilityService } from './availability.service';
import { AvailabilityOwner } from './availability.entity';
import { UpsertAvailabilityDto } from './dto/upsert-availability.dto';

@ApiTags('availability')
@Controller('availability')
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get()
  @ApiOperation({ summary: '가용/불가 블록 목록(ownerType·ownerId 필터)' })
  @ApiQuery({ name: 'ownerType', required: false, enum: ['student', 'instructor', 'room'] })
  @ApiQuery({ name: 'ownerId', required: false })
  @ApiOkResponse({ description: 'AvailabilityBlock[] — { id, ownerType, ownerId, kind, weekday, startTime, endTime }' })
  list(
    @Query('ownerType') ownerType?: AvailabilityOwner,
    @Query('ownerId') ownerId?: string,
  ) {
    return this.availability.list(ownerType, ownerId ? Number(ownerId) : undefined);
  }

  @Put()
  @ApiOperation({ summary: '가용/불가 블록 생성·수정(id 있으면 수정). 같은 오너·요일 겹침 시 409.' })
  @ApiOkResponse({ description: 'AvailabilityBlock(생성/수정 결과)' })
  @ApiConflictResponse({ description: '이미 지정된 가용/불가 시간과 겹침(겹친 시각 메시지 포함)' })
  @ApiBadRequestResponse({ description: '존재하지 않는 강의실 owner 등' })
  upsert(@Body() dto: UpsertAvailabilityDto) {
    return this.availability.upsert(dto);
  }

  @Delete(':id')
  @ApiParam({ name: 'id', description: '블록 id' })
  @ApiOperation({ summary: '가용/불가 블록 삭제' })
  @ApiOkResponse({ description: '{ id, deleted: boolean }' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.availability.remove(id);
  }
}
