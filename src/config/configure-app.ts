import { INestApplication, ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
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
  // API responses do not render HTML, so CSP belongs to the frontend. The remaining Helmet
  // defaults centrally remove framework disclosure and add MIME, framing and referrer guards.
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    strictTransportSecurity: process.env.NODE_ENV === 'production' ? undefined : false,
  }));
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
