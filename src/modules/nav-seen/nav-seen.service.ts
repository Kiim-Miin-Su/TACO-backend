// [B3 2026-07-16 대표 결정 ①] 알림 뱃지 읽음 — 사용자×탭 마지막 열람 시각의 서버 영속.
//  탭 진입 시 FE가 mark를 호출하고, 뱃지는 "열람 이후 새 활동"이 있을 때만 표시된다.
//  감사 제외 근거: 이 행 자체가 열람 이력(고빈도 UI 상태) — erd.dbml audit_log Note의 명시 예외.
import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import type { BaseRow } from '../../common/types/base';
import { NAV_SEEN_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { InMemoryDatabase } from '../../database/in-memory.database';

export const NAV_SEEN = 'nav_seen_states';

// 뱃지가 존재하는 탭 키만 허용(슬래시 없는 정규 키 — FE lib/tasks navBadges와 1:1).
export const NAV_KEYS = ['calendar', 'counsel', 'payments', 'payouts', 'expenses', 'reports', 'admin'] as const;
export type NavKey = (typeof NAV_KEYS)[number];

export type NavSeenRow = {
  userId: number;
  navKey: string;
  lastSeenAt: string;
} & BaseRow;

@Injectable()
export class NavSeenService implements OnModuleInit {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.store.hydrate<NavSeenRow>(NAV_SEEN_SPEC);
  }

  /** 내 열람 시각 맵 — { navKey: lastSeenAtIso } */
  async listMine(userId: number): Promise<Record<string, string>> {
    await this.store.hydrate<NavSeenRow>(NAV_SEEN_SPEC); // 교차 인스턴스 정합(행 수 = 사용자×7 — 저비용)
    const out: Record<string, string> = {};
    for (const row of this.db.findByField<NavSeenRow>(NAV_SEEN, 'userId', userId)) {
      out[row.navKey] = row.lastSeenAt;
    }
    return out;
  }

  /** 탭 진입 마킹 — (user, navKey) upsert. 반환은 갱신된 시각. */
  async mark(userId: number, navKey: string): Promise<{ navKey: string; lastSeenAt: string }> {
    if (!NAV_KEYS.includes(navKey as NavKey)) {
      throw new BadRequestException(`navKey는 ${NAV_KEYS.join('|')} 중 하나여야 합니다.`);
    }
    const now = new Date().toISOString();
    const saved = await this.store.upsertActive<NavSeenRow>(
      NAV_SEEN_SPEC,
      ['userId', 'navKey'],
      { userId, navKey, lastSeenAt: now } as Omit<NavSeenRow, keyof BaseRow>,
    );
    return { navKey, lastSeenAt: saved.lastSeenAt };
  }
}
