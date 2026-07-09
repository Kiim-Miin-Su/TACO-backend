const LOCAL_WEB_ORIGIN = 'http://localhost:3000';
const PRODUCTION_WEB_ORIGIN = 'https://taco-frontend-tau.vercel.app';

export function webCorsOrigins(): true | string[] {
  const configured = (process.env.WEB_ORIGIN ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  // 로컬 QA는 포트가 자주 바뀐다(Next dev/start, preview, browser QA).
  // credentials=true와 함께 쓰려면 '*'가 아니라 요청 Origin을 반사하는 origin=true가 안전한 CORS 표현이다.
  if (process.env.NODE_ENV !== 'production' && process.env.CORS_STRICT_LOCAL !== '1') return true;

  const defaults = process.env.NODE_ENV === 'production'
    ? [PRODUCTION_WEB_ORIGIN]
    : [LOCAL_WEB_ORIGIN];

  return Array.from(new Set([...configured, ...defaults]));
}
