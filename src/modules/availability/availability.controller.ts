import { Body, Controller, Delete, Get, Param, ParseIntPipe, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AvailabilityService } from './availability.service';
import { AvailabilityOwner } from './availability.entity';
import { UpsertAvailabilityDto } from './dto/upsert-availability.dto';

@ApiTags('availability')
@Controller('availability')
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get()
  list(
    @Query('ownerType') ownerType?: AvailabilityOwner,
    @Query('ownerId') ownerId?: string,
  ) {
    return this.availability.list(ownerType, ownerId ? Number(ownerId) : undefined);
  }

  @Put()
  upsert(@Body() dto: UpsertAvailabilityDto) {
    return this.availability.upsert(dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.availability.remove(id);
  }
}
