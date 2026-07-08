const LOCAL_WEB_ORIGIN = 'http://localhost:3000';
const PRODUCTION_WEB_ORIGIN = 'https://taco-frontend-tau.vercel.app';

export function webCorsOrigins(): string[] {
  const configured = (process.env.WEB_ORIGIN ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  const defaults = process.env.NODE_ENV === 'production'
    ? [PRODUCTION_WEB_ORIGIN]
    : [LOCAL_WEB_ORIGIN];

  return Array.from(new Set([...configured, ...defaults]));
}
