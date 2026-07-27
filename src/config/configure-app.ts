import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AllExceptionsFilter } from '../common/all-exceptions.filter';
import { webCorsOrigins } from '../common/cors-origin';
import { LoggingInterceptor } from '../common/logging.interceptor';
import { RawPositiveIntBoundaryPipe } from '../common/positive-int.pipe';
import { requestContextMiddleware } from '../common/request-context';
import { configureTrustProxy } from '../common/trust-proxy';

export interface ConfigureAppOptions {
  cors?: boolean;
  observability?: boolean;
}

export function configureApp(
  app: INestApplication,
  options: ConfigureAppOptions = {},
): void {
  const { cors = true, observability = true } = options;

  configureTrustProxy(app);
  app.use(requestContextMiddleware);
  if (cors) {
    app.enableCors({
      origin: webCorsOrigins(),
      credentials: true,
    });
  }
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new RawPositiveIntBoundaryPipe(),
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  if (observability) {
    app.useGlobalInterceptors(new LoggingInterceptor());
    app.useGlobalFilters(new AllExceptionsFilter());
  }
}
