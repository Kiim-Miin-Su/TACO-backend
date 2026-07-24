// [TBO-58 P2 2026-07-24] requestId 상관관계 — 동시 요청에서 "이 로그 줄이 어느 요청 소속인지"를
//  식별한다(치명 갭 ①: 동시 요청 추적 단절). AsyncLocalStorage 하나로 미들웨어→서비스→필터 전 구간
//  전파(파라미터 배관 없음 — 단일 진실원). 소비 지점 2곳:
//  - logLine()(운영 JSON): rid 필드 자동 첨부(category=http/error/audit/app 전부)
//  - RidConsoleLogger(개발 한 줄·도메인 스코프 money/attendance/counsel/analytics): 문자열 끝에 rid= 첨부
//  FE(lib/api.ts)가 요청마다 X-Request-Id를 보내면 그 값을 그대로 채택 — 브라우저 콘솔의 [TACO:api]
//  로그와 서버 로그를 같은 rid로 교차 대조할 수 있다. 응답 헤더로도 반환(X-Request-Id).
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ConsoleLogger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

const storage = new AsyncLocalStorage<{ requestId: string }>();
// FE가 보낸 rid 수용 형식 — 자유 문자열 주입 방지(로그 위조·개행 삽입 차단)
const INCOMING_RE = /^[A-Za-z0-9._-]{4,64}$/;

export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = String(req.headers['x-request-id'] ?? '');
  const requestId = INCOMING_RE.test(incoming) ? incoming : randomUUID().slice(0, 8);
  res.setHeader('X-Request-Id', requestId);
  storage.run({ requestId }, next);
}

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/**
 * 전 Logger 출력에 rid를 자동 첨부하는 로거 — 도메인 스코프 로그(money 등)를 한 줄도 고치지 않고
 * 상관관계를 얻는 단일 지점. 운영 JSON 라인(logLine이 이미 rid 필드 포함)은 '{'로 시작하므로 건너뛴다.
 */
export class RidConsoleLogger extends ConsoleLogger {
  private withRid(message: unknown): unknown {
    const rid = currentRequestId();
    if (!rid || typeof message !== 'string') return message;
    if (message.startsWith('{') || message.includes('rid=')) return message; // JSON/중복 방지
    return `${message} rid=${rid}`;
  }
  override log(message: unknown, ...rest: unknown[]): void { super.log(this.withRid(message), ...(rest as [string?])); }
  override warn(message: unknown, ...rest: unknown[]): void { super.warn(this.withRid(message), ...(rest as [string?])); }
  override error(message: unknown, ...rest: unknown[]): void { super.error(this.withRid(message), ...(rest as [string?, string?])); }
  override debug(message: unknown, ...rest: unknown[]): void { super.debug(this.withRid(message), ...(rest as [string?])); }
  override verbose(message: unknown, ...rest: unknown[]): void { super.verbose(this.withRid(message), ...(rest as [string?])); }
}
