// [테스트 안정화 2026-07-03] e2e를 환경 무관(hermetic)하게 — 개발자 머신의 .env/셸에 SMTP·JWT가
//  잡혀 있어도 테스트는 항상 동일 조건에서 돈다. setupFiles라 모든 모듈 import·인스턴스화 전에 실행됨.
//
//  · SMTP_* 제거: MailService가 실제 메일 발송을 시도하지 않고 dev 폴백(devLink 반환)만 쓰도록 →
//    auth(가입→인증) 테스트가 SMTP 설정 여부와 무관하게 결정론적으로 통과. 실제 메일 미발송(안전).
//  · JWT_SECRET/EXPIRES: 서명·만료를 테스트 고정값으로 통일(로컬 .env 값에 흔들리지 않게).
//  · NCP_SENS_*/TWILIO_* 제거: 개발자 머신 credential이 새면 sms 코드 소유권(ownsCode)이 뒤집혀
//    fake 기반 스위트가 비결정적으로 깨진다 — SENS 스위트는 자체적으로 주입 후 원복한다.
for (const k of [
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM',
  'NCP_SENS_ACCESS_KEY', 'NCP_SENS_SECRET_KEY', 'NCP_SENS_SERVICE_ID', 'NCP_SENS_FROM',
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_VERIFY_SERVICE_SID',
]) {
  delete process.env[k];
}
process.env.JWT_SECRET = 'e2e-test-secret';
process.env.JWT_EXPIRES_IN = '1h';
