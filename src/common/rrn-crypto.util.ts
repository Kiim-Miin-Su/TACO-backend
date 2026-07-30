// [TBO-31 C1 D2] 주민등록번호(RRN) 암호화·마스킹·형식 검증 유틸.
//  · 수집 근거: 강사 급여 원천징수·지급명세서 제출(소득세법) — 저장은 암호화 의무(개인정보보호법
//    시행령 제21조의2) → AES-256-GCM. DB에는 users.rrn_encrypted(암호문)만 존재한다.
//  · 노출 규약: API 응답·화면은 maskRrn 결과만('950101-1******'), audit_log·로그에는 **일절
//    미기록**(마스킹조차 남기지 않는다 — 기록 자체 생략). 평문은 검증·암호화·파생 계산에만 쓴다.
//  · 키: env RRN_ENC_KEY(base64 32B). production 미설정은 production-guards가 **부팅 자체를 차단**
//    하므로 여기서는 throw하지 않는다. 비production은 JWT dev 시크릿 sha256 파생 + 경고 1회.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { isValidRrnFormat } from '@kms545487/contracts';

// [TBO-79 I1] 형식·정규화·마스킹의 소유는 contracts/src/rrn.ts로 이관했다. 여기와 FE
//  lib/validation.ts가 같은 규칙을 각자 구현하다 두 군데가 갈라져 있었다:
//   ① 이 파일의 validateRrnFormat은 trim을 하지 않아 `'950101-1234567 '`을 거부하는데
//      FE isValidRrn은 trim 후 검사해 통과시켰다 → 화면은 "올바름", 저장은 400.
//   ② 이 파일의 digitsOf는 `replace('-', '')`로 **첫 하이픈만** 지웠고 FE는 전부 지웠다 →
//      성별 자리(index 6)가 밀리면 birthYearFromRrn의 세기 판정이 뒤집힌다.
//  이 모듈은 이제 **암호화만** 소유한다(서버 전용). 순수 함수는 재export만 한다 — 사본 금지.
export {
  RRN_REGEX,
  RRN_FORMAT_MESSAGE,
  rrnDigits,
  normalizeRrn,
  birthYearFromRrn,
  maskRrn,
} from '@kms545487/contracts';

/** 기존 호출부 호환 별칭 — 구현은 contracts의 isValidRrnFormat 하나다. */
export const validateRrnFormat = isValidRrnFormat;

let warnedDevKey = false;

/** 암호화 키 — RRN_ENC_KEY(base64 32B). 미설정 시 개발 한정 JWT 시크릿 파생(경고 1회).
 *  production 미설정은 production-guards의 부팅 fail-fast가 선행 차단하므로 이 폴백에 도달하지 않는다. */
function encryptionKey(): Buffer {
  const raw = process.env.RRN_ENC_KEY;
  if (raw) {
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) throw new Error('[rrn] RRN_ENC_KEY는 base64 인코딩된 32바이트 키여야 합니다.');
    return key;
  }
  if (!warnedDevKey) {
    console.warn('[rrn] RRN_ENC_KEY 미설정 — 개발용 파생 키(JWT 시크릿 sha256)를 사용합니다. 운영 사용 금지.');
    warnedDevKey = true;
  }
  return createHash('sha256').update(`rrn-enc:${process.env.JWT_SECRET ?? 'dev-jwt-secret'}`).digest();
}

const IV_BYTES = 12; // GCM 권장 96-bit nonce
const TAG_BYTES = 16;

// [TBO-34 C2-C 2026-07-23] 키 버전 태그·회전(리뷰 보안 ④) — 신규 암호문은 `v1:` 접두(현행 키).
//  복호화는 ① v1: 현행 키 → 이전 키(RRN_ENC_KEY_PREVIOUS) 순 시도 ② 무접두(레거시) 동일 순서.
//  회전 절차: RUNBOOK 문서 — 새 키를 RRN_ENC_KEY로, 구 키를 RRN_ENC_KEY_PREVIOUS로 배치 →
//  scripts/rotate-rrn-key.ts 재암호화 → PREVIOUS 제거. GCM authTag가 키 불일치를 판정한다.
const VERSION_PREFIX = 'v1:';

function previousKey(): Buffer | null {
  const raw = process.env.RRN_ENC_KEY_PREVIOUS;
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('[rrn] RRN_ENC_KEY_PREVIOUS는 base64 인코딩된 32바이트 키여야 합니다.');
  return key;
}

/** AES-256-GCM 암호화 — 저장 포맷 `v1:` + base64(iv 12B ‖ authTag 16B ‖ ciphertext). */
export function encryptRrn(plainRrn: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plainRrn, 'utf8'), cipher.final()]);
  return VERSION_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

function decryptWith(key: Buffer, buf: Buffer): string {
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** 이 암호문이 현행 포맷(v1)인가 — 회전 스크립트의 재암호화 대상 판정에 사용. */
export function isCurrentRrnFormat(payload: string): boolean {
  return payload.startsWith(VERSION_PREFIX);
}

/** 복호화 — 승인센터 마스킹 산출 등 서버 내부 전용. 결과 평문을 응답·로그에 그대로 싣지 말 것.
 *  v1 접두·레거시(무접두) 모두 수용, 현행 키 → 이전 키 순서로 시도(회전 창 무중단). */
export function decryptRrn(payload: string): string {
  const raw = isCurrentRrnFormat(payload) ? payload.slice(VERSION_PREFIX.length) : payload;
  const buf = Buffer.from(raw, 'base64');
  if (buf.length <= IV_BYTES + TAG_BYTES) throw new Error('[rrn] 잘못된 암호문 포맷입니다.');
  try {
    return decryptWith(encryptionKey(), buf);
  } catch (primaryError) {
    const previous = previousKey();
    if (!previous) throw primaryError;
    return decryptWith(previous, buf); // 이전 키도 실패하면 원 오류 형태로 전파
  }
}
