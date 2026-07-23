// [TBO-34 C2-C 2026-07-23] RRN 암호화 키 회전 — users.rrn_encrypted 전 행을 현행 키(v1 포맷)로
//  재암호화한다(리뷰 보안 ④). 절차(RUNBOOK 문서 §키 회전):
//   ① 새 키를 RRN_ENC_KEY, 구 키를 RRN_ENC_KEY_PREVIOUS로 배치(서비스 재배포 — 복호화는 양쪽 시도)
//   ② 이 스크립트 dry-run으로 대상 확인 → --apply 재암호화 ③ 전 행 v1 확인 후 PREVIOUS 제거.
//  로그에는 건수만 남기고 평문·암호문·키는 절대 출력하지 않는다(상시 보안 규약).
import { Client } from 'pg';
import { resolvePgSsl } from '../src/database/pg-ssl';
import { decryptRrn, encryptRrn, isCurrentRrnFormat } from '../src/common/rrn-crypto.util';

const APPLY = process.argv.includes('--apply') || process.env.APPLY === '1';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!url) throw new Error('DATABASE_URL이 필요합니다.');
  const client = new Client({ connectionString: url, ssl: resolvePgSsl() });
  await client.connect();
  try {
    const { rows } = await client.query(
      'select id, rrn_encrypted from users where rrn_encrypted is not null and deleted_at is null');
    let legacy = 0, current = 0, rotated = 0, failed = 0;
    for (const row of rows) {
      const payload: string = row.rrn_encrypted;
      // 현행 키로 이미 유효한 v1 암호문이면 대상 아님(멱등) — 복호 성공 여부까지 확인
      let plain: string;
      try {
        plain = decryptRrn(payload); // 현행 → 이전 키 순 시도
      } catch {
        failed += 1; // 어떤 키로도 복호 불가 — 수동 조사 대상(값 미출력)
        console.error(`[rotate] users.id=${row.id} 복호 실패 — 키 배치 확인 필요`);
        continue;
      }
      const needsRotation = !isCurrentRrnFormat(payload) || !decryptsWithCurrentOnly(payload);
      if (!needsRotation) { current += 1; continue; }
      legacy += 1;
      if (!APPLY) continue;
      await client.query('update users set rrn_encrypted = $1, updated_at = now() where id = $2',
        [encryptRrn(plain), row.id]);
      rotated += 1;
    }
    console.log(JSON.stringify({
      mode: APPLY ? 'APPLY' : 'dry-run', total: rows.length,
      alreadyCurrent: current, rotationTargets: legacy, rotated, failed,
    }, null, 2));
    if (failed > 0) process.exit(1);
  } finally {
    await client.end();
  }
}

/** 현행 키 단독으로 복호되는가 — PREVIOUS 폴백 없이 성공해야 회전 완료로 판정. */
function decryptsWithCurrentOnly(payload: string): boolean {
  const previous = process.env.RRN_ENC_KEY_PREVIOUS;
  try {
    delete process.env.RRN_ENC_KEY_PREVIOUS;
    decryptRrn(payload);
    return true;
  } catch {
    return false;
  } finally {
    if (previous !== undefined) process.env.RRN_ENC_KEY_PREVIOUS = previous;
  }
}

main().catch((e) => { console.error('[rotate] 실패:', (e as Error).message); process.exit(1); });
