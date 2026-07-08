// [R3 2026-07-06 — 7/3 리뷰 ⑦ 후속] 전역 예외 필터.
//  - HttpException: 기존 응답 형태 **그대로 통과**(409 {message, conflicts}·400 검증 배열 등 —
//    e2e가 계약으로 검증하는 형태를 절대 바꾸지 않는다). category=error 로그만 추가(4xx=warn·5xx=error).
//  - 비-HttpException(코드 버그): 스택을 응답에 싣지 않고 500 {statusCode, message}로 표준화 —
//    스택은 서버 로그(category=error)에만. (이전엔 Nest 기본 처리에 의존 — 노출 여부가 버전 종속이었음)
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { logLine } from './log-line';
import { safeUrlForLog } from './log-redaction';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ERROR');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const path = safeUrlForLog(req.originalUrl);

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const line = logLine('error', {
        kind: 'HttpException', method: req.method, path, status,
        message: exception.message,
      });
      if (status >= 500) this.logger.error(line);
      else this.logger.warn(line);
      // 응답 형태 보존: 문자열이면 Nest 기본 래핑과 동일하게, 객체면 그대로
      if (typeof body === 'string') res.status(status).json({ statusCode: status, message: body });
      else res.status(status).json(body);
      return;
    }

    // 코드 버그(비-HttpException) — 응답 최소화 + 스택은 서버에만
    const status = HttpStatus.INTERNAL_SERVER_ERROR;
    const err = exception as Error;
    this.logger.error(
      logLine('error', { kind: 'Unhandled', method: req.method, path, status, message: err?.message }),
      err?.stack,
    );
    res.status(status).json({ statusCode: status, message: 'Internal server error' });
  }
}
