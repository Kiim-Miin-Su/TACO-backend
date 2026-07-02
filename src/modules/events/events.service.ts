import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { AcademyEvent, ACADEMY_EVENTS } from './event.entity';
import { CreateEventDto } from './dto/create-event.dto';

@Injectable()
export class EventsService implements OnModuleInit {
  constructor(private readonly db: InMemoryDatabase) {}

  // 데모 학원 이벤트 시드 — 프론트 목데이터 이관(FK 없음). 고정 id 1~4로 하이드레이션 멱등.
  // 시작일 오름차순은 캘린더 표시 순서일 뿐 무결성 제약은 아님.
  onModuleInit(): void {
    this.db.seed<AcademyEvent>(ACADEMY_EVENTS, [
      { id: 1, title: '여름 특강 등록 시작', type: 'notice', priority: 'high', startDate: '2026-06-25', endDate: '2026-06-30' },
      { id: 2, title: 'SAT 모의고사', type: 'exam', priority: 'high', startDate: '2026-06-28', endDate: '2026-06-28', allDay: true },
      { id: 3, title: '창립기념일 휴원', type: 'holiday', priority: 'high', startDate: '2026-07-01', endDate: '2026-07-01', allDay: true },
      { id: 4, title: '자습실 연장 운영', type: 'notice', priority: 'normal', startDate: '2026-06-26', endDate: '2026-06-30' },
    ]);
  }

  findAll(): AcademyEvent[] {
    // 캘린더 표시 순서: 시작일 오름차순(동일 시작일이면 id).
    return this.db
      .findAll<AcademyEvent>(ACADEMY_EVENTS)
      .slice()
      .sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : a.id - b.id));
  }

  // 무결성 게이트: 캘린더 구간이 유효해야 함(종료일 ≥ 시작일). 위반 시 400.
  create(dto: CreateEventDto): AcademyEvent {
    if (dto.endDate < dto.startDate) {
      throw new BadRequestException('endDate must be on or after startDate');
    }
    return this.db.insert<AcademyEvent>(ACADEMY_EVENTS, {
      title: dto.title,
      type: dto.type,
      priority: dto.priority ?? 'normal',
      startDate: dto.startDate,
      endDate: dto.endDate,
      allDay: dto.allDay,
      memo: dto.memo,
    });
  }
}
