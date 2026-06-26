// 환경설정 단일 진입점. 추후 @nestjs/config 도입 시 이 형태를 ConfigModule로 옮깁니다.
export type AppConfig = {
  port: number;
  webOrigin: string;
  jwtSecret: string;
  jwtExpiresIn: string;
};

export const loadConfig = (): AppConfig => ({
  port: Number(process.env.PORT ?? 3001),
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '1h',
});
