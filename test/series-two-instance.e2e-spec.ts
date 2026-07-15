// [TBO-29C C3] 두 인스턴스 PostgreSQL 실증 — 같은 series 동시 scope 변경이 인스턴스 경계를 넘어
//  advisory lock(series)으로 직렬화되고 version CAS가 stale 명령을 409 처리하는지.
//  in-memory 모드는 인스턴스 간 공유 저장소가 없어 의미가 없으므로 skip(DATABASE_URL 필수).
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';

const HAS_DB = !!(process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL);

(HAS_DB ? describe : describe.skip)('[TBO-29C C3] two-instance PostgreSQL series serialization', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let httpA: ReturnType<typeof request>;
  let httpB: ReturnType<typeof request>;
  let ADMIN_A = '';
  let ADMIN_B = '';

  beforeAll(async () => {
    appA = await createTestApp();
    appB = await createTestApp();
    httpA = request(appA.getHttpServer());
    httpB = request(appB.getHttpServer());
    ADMIN_A = (await httpA.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
    ADMIN_B = (await httpB.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
  });
  afterAll(async () => {
    await appA?.close();
    await appB?.close();
  });

  it('같은 series 동시 scope 변경(서로 다른 인스턴스·서로 다른 회차) — 성공 1 · SERIES_VERSION_STALE 409 1, 부분 회차 0', async () => {
    const made = (await httpA.post('/api/schedule/series').set({ Authorization: `Bearer ${ADMIN_A}` })
      .send({ courseId: 10, instructorId: 1, repeat: { kind: 'weekly', weekdays: [4], startsOn: '2100-03-04', endsOn: '2100-03-18' }, startTime: '09:00', durationMinutes: 60, topic: '두인스턴스' })
      .expect(201)).body as { series: { id: number }; rows: Array<{ id: number }> };
    const [r1, r2] = made.rows;

    const [a, b] = await Promise.all([
      httpA.patch(`/api/schedule/${r1.id}`).set({ Authorization: `Bearer ${ADMIN_A}` })
        .send({ startTime: '10:00', scope: 'all', expectedSeriesVersion: 1 }),
      httpB.patch(`/api/schedule/${r2.id}`).set({ Authorization: `Bearer ${ADMIN_B}` })
        .send({ startTime: '11:00', scope: 'all', expectedSeriesVersion: 1 }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.code).toBe('SERIES_VERSION_STALE');
    const winnerTime = a.status === 200 ? '10:00' : '11:00';

    // 양쪽 인스턴스 readback 일치 — 부분 회차 0
    for (const [h, token] of [[httpA, ADMIN_A], [httpB, ADMIN_B]] as const) {
      const rows = (await h.get('/api/schedule?from=2100-03-04&to=2100-03-18').set({ Authorization: `Bearer ${token}` }).expect(200))
        .body as Array<{ seriesId?: number; startTime?: string; seriesVersion?: number }>;
      const members = rows.filter((r) => r.seriesId === made.series.id);
      expect(members).toHaveLength(3);
      expect(members.every((m) => m.startTime === winnerTime)).toBe(true);
      expect(members[0]?.seriesVersion).toBe(2);
    }
  });
});
