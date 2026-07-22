// 빌드 타임 OpenAPI 생성 — 서버리스(@vercel/node)에서 런타임 데코레이터 메타데이터가
// 소실되어도, 여기서 미리 만든 openapi.json을 서빙하면 파라미터/스키마가 항상 정확히 표시된다.
// 실행: npm run openapi  (→ backend/openapi.json 생성, api/index.ts가 이 파일을 로드)
import { NestFactory } from '@nestjs/core';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { dump } from 'js-yaml';
import { AppModule } from '../src/app.module';
import { createOpenApiDocument } from '../src/config/openapi';

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api');
  const document = createOpenApiDocument(app);
  // 프로젝트 루트(=npm 실행 cwd)에 기록 — 컴파일 위치(dist/scripts)에 무관하게 backend/openapi.json.
  const out = join(process.cwd(), 'openapi.json');
  writeFileSync(out, JSON.stringify(document, null, 2));
  writeFileSync(join(process.cwd(), 'docs/api/openapi.yaml'), dump(document, { noRefs: true, lineWidth: 120 }));
  await app.close();
  // eslint-disable-next-line no-console
  console.log(`openapi 생성 완료 — paths=${Object.keys(document.paths).length}, schemas=${Object.keys(document.components?.schemas ?? {}).length}`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
