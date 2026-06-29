import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { Room, ROOMS } from './room.entity';
import { CreateRoomDto } from './dto/create-room.dto';

@Injectable()
export class RoomsService implements OnModuleInit {
  constructor(private readonly db: InMemoryDatabase) {}

  // 부팅 시 데모 강의실 시드(in-memory)
  onModuleInit(): void {
    if (this.db.findAll<Room>(ROOMS).length) return;
    const seed: Omit<Room, 'id' | 'createdAt' | 'updatedAt'>[] = [
      { name: 'A101', capacity: 8, color: '#0969da', isActive: true },
      { name: 'A102', capacity: 6, color: '#1a7f37', isActive: true },
      { name: 'B201 (세미나)', capacity: 16, color: '#8250df', isActive: true },
    ];
    seed.forEach((r) => this.db.insert<Room>(ROOMS, r));
  }

  findAll(): Room[] {
    return this.db.findAll<Room>(ROOMS);
  }

  findOne(id: number): Room {
    const row = this.db.findById<Room>(ROOMS, id);
    if (!row) throw new NotFoundException(`Room ${id} not found`);
    return row;
  }

  create(dto: CreateRoomDto): Room {
    return this.db.insert<Room>(ROOMS, {
      name: dto.name,
      buildingId: dto.buildingId,
      capacity: dto.capacity,
      color: dto.color,
      isActive: dto.isActive ?? true,
    });
  }
}
