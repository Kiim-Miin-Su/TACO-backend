// [TBO-70 2026-07-26] 브라우저 QA 픽스처 서버 — 리뷰어(사람·에이전트)가 실제 브라우저로
//  복잡 흐름(USER-FLOWS J1~J3)을 클릭 검증할 수 있는 **공식 로컬 구동 진입점**.
//  · e2e와 같은 앱 부팅(createTestApp — main.ts 패리티: ValidationPipe·requestContext·no-store)
//    + 업무 픽스처(test/fixtures — 데모 계정 admin/manager/park_inst/jung_inst, 비밀번호는
//    데모 공통값 demo1234: production-guards가 운영에서 로그인 차단하는 값이라 유출 무해).
//  · **hermetic 강제**: 셸에 DATABASE_URL/POSTGRES_URL이 있어도 제거 — QA 서버가 운영 DB에
//    붙는 사고 원천 차단(jest-e2e.setup과 같은 규약). 전 데이터는 in-memory(재시작=초기화).
//  실행: `npm run qa:server` (기본 :3001 — frontend `npm run dev`의 rewrite 기본값과 일치.
//  즉 두 터미널: backend `npm run qa:server` + frontend `npm run dev` → http://localhost:3000)
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.POSTGRES_PRISMA_URL;
delete process.env.POSTGRES_URL_NON_POOLING;
process.env.NODE_ENV = 'test';

import { createTestApp } from './setup-app';
import { seedQaPendingPayoutFixture } from './fixtures/seed-qa-payout-fixture';

async function main() {
  const port = Number(process.env.PORT) || 3001;
  const app = await createTestApp();
  const payoutFixture = await seedQaPendingPayoutFixture(app);
  await app.listen(port);
  console.log(`[qa] fixture server on :${port} — in-memory·업무 픽스처 시드(재시작=초기화)`);
  console.log(`[qa] editable pending payout #${payoutFixture.payout.id} — service/UoW 생성`);
  console.log('[qa] 데모 계정: admin(대표) · manager(매니저) · park_inst/jung_inst(강사) — 비밀번호는 데모 공통값');
}
main().catch((e) => { console.error(e); process.exit(1); });
