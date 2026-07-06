import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import type { Request, Response } from 'express';
import { logLine } from './log-line';

/**
 * 모든 HTTP 요청을 한 줄로 로깅 — 문제 발생 시 "어떤 요청이 몇 ms에 무슨 상태로 끝났는지" 추적.
 * 출력 예) [HTTP] POST /api/schedule 201 8ms
 *         [HTTP] POST /api/auth/login 401 5ms — 아이디 또는 비밀번호가 올바르지 않습니다.
 * 진단 가이드: docs/logging.md
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const { method, originalUrl } = req;
    const started = Date.now();
    return next.handle().pipe(
      tap({
        next: () => {
          const res = ctx.switchToHttp().getResponse<Response>();
          // [R3] category=http — method·path·status·durationMs(운영=JSON 라인, 개발=한 줄)
          this.logger.log(logLine('http', { method, path: originalUrl, status: res.statusCode, ms: Date.now() - started }));
        },
        error: (err: { status?: number; message?: string }) => {
          // 에러 응답 본문·처리는 AllExceptionsFilter(category=error) 담당 — 여기선 http 계측만
          this.logger.warn(logLine('http', { method, path: originalUrl, status: err?.status ?? 500, ms: Date.now() - started, message: err?.message }));
        },
      }),
    );
  }
}
