// [TBO-31 C1 D2] 주민등록번호(RRN) 암호화·마스킹·형식 검증 유틸.
//  · 수집 근거: 강사 급여 원천징수·지급명세서 제출(소득세법) — 저장은 암호화 의무(개인정보보호법
//    시행령 제21조의2) → AES-256-GCM. DB에는 users.rrn_encrypted(암호문)만 존재한다.
//  · 노출 규약: API 응답·화면은 maskRrn 결과만('950101-1******'), audit_log·로그에는 **일절
//    미기록**(마스킹조차 남기지 않는다 — 기록 자체 생략). 평문은 검증·암호화·파생 계산에만 쓴다.
//  · 키: env RRN_ENC_KEY(base64 32B). production 미설정은 production-guards가 **부팅 자체를 차단**
//    하므로 여기서는 throw하지 않는다. 비production은 JWT dev 시크릿 sha256 파생 + 경고 1회.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/** 형식 정규식 — 앞 6자리(생년월일) + 성별자리 1~8(내국인 1-4·외국인 5-8) + 6자리. 하이픈 선택. */
export const RRN_REGEX = /^\d{6}-?[1-8]\d{6}$/;
export const RRN_FORMAT_MESSAGE = '주민등록번호 형식이 올바르지 않습니다(예: 950101-1234567).';

const digitsOf = (raw: string): string => raw.replace('-', '');

/**
 * 형식 검증 — 정규식 + 앞 6자리의 MM(01-12)·DD(01-31) 타당성만 본다.
 * **체크섬 검증은 하지 않는다**: 2020-10 이후 발급분은 뒷자리가 임의번호라 검증식이 폐지됐다
 * (구 검증식을 적용하면 합법 신규 번호를 거부하는 오류가 된다).
 */
export function validateRrnFormat(raw: string): boolean {
  if (!RRN_REGEX.test(raw)) return false;
  const digits = digitsOf(raw);
  const mm = Number(digits.slice(2, 4));
  const dd = Number(digits.slice(4, 6));
  return mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
}

/** canonical 저장 형태 — 하이픈 포함('950101-1234567')으로 통일. 형식 검증 후 호출 전제. */
export function normalizeRrn(raw: string): string {
  const digits = digitsOf(raw.trim());
  return `${digits.slice(0, 6)}-${digits.slice(6)}`;
}

/** 성별 자리 1,2,5,6 → 19xx / 3,4,7,8 → 20xx (내국인·외국인 동일 세기 규칙). */
export function birthYearFromRrn(raw: string): number {
  const digits = digitsOf(raw.trim());
  const century = ['1', '2', '5', '6'].includes(digits[6]) ? 1900 : 2000;
  return century + Number(digits.slice(0, 2));
}

/** 노출용 마스킹 — 생년월일 6자리 + 성별 자리만 남긴다: '950101-1******'. */
export function maskRrn(raw: string): string {
  const digits = digitsOf(raw.trim());
  return `${digits.slice(0, 6)}-${digits[6]}******`;
}

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
    // eslint-disable-next-line no-console
    console.warn('[rrn] RRN_ENC_KEY 미설정 — 개발용 파생 키(JWT 시크릿 sha256)를 사용합니다. 운영 사용 금지.');
    warnedDevKey = true;
  }
  return createHash('sha256').update(`rrn-enc:${process.env.JWT_SECRET ?? 'dev-jwt-secret'}`).digest();
}

const IV_BYTES = 12; // GCM 권장 96-bit nonce
const TAG_BYTES = 16;

/** AES-256-GCM 암호화 — 저장 포맷 base64(iv 12B ‖ authTag 16B ‖ ciphertext). */
export function encryptRrn(plainRrn: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plainRrn, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

/** 복호화 — 승인센터 마스킹 산출 등 서버 내부 전용. 결과 평문을 응답·로그에 그대로 싣지 말 것. */
export function decryptRrn(payload: string): string {
  const buf = Buffer.from(payload, 'base64');
  if (buf.length <= IV_BYTES + TAG_BYTES) throw new Error('[rrn] 잘못된 암호문 포맷입니다.');
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
