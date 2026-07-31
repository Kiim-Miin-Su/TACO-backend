// [TBO-80 80B = TBO-79 C6] 라우트 정책 선언 정적 게이트.
//
// 배경: RolesGuard가 전역 default-auth라 "미선언 라우트"도 로그인은 요구하지만(TBO-79 축4),
// 정책이 **선언되지 않은** 라우트는 리뷰어가 public/역할/capability 중 무엇이 의도인지 알 수 없고,
// TBO-79의 209 라우트 전수 확인은 수동이었다(재발 방어 장치 없음). 이 게이트는:
//   1) 모든 HTTP 라우트 메서드가 @Public | @Roles | @RequireCapabilities 중 하나를
//      (메서드 또는 클래스 레벨에서) 선언했는지 검사하고 — 위반 시 exit 1
//   2) @Public 라우트 집합을 사유 있는 allowlist로 고정한다 — 새 public 라우트가 조용히
//      들어오거나(추가 시 여기 사유 명기) allowlist가 낡으면(제거) exit 1
//   3) 분류 집계를 출력한다(기준선 2026-07-31: total 209 = public 20 / capability 55 / role 134)
//
// 한계: TypeScript AST 정적 검사다. 데코레이터를 동적으로 합성하면(applyDecorators 등) 못 본다 —
// 현재 코드베이스는 세 데코레이터를 전부 직접 표기하며, 새 합성 패턴 도입 시 이 게이트를 함께 확장한다.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';

const SRC_ROOT = join(__dirname, '..', 'src');
const HTTP_DECORATORS = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'Head', 'Options', 'All']);
const POLICY_DECORATORS = ['Public', 'Roles', 'RequireCapabilities'] as const;
type Policy = (typeof POLICY_DECORATORS)[number];

// ── @Public 허용 목록 — 라우트 라벨(HTTP VERB + controller path + method path) 전수, 사유 필수 ──
// 기준선 실측 2026-07-31 (TBO-79 축4 20개와 동일 집합). 새 public 라우트는 여기 사유와 함께 추가.
const PUBLIC_ALLOWLIST: Record<string, string> = {
  'POST auth/signup-email-challenge': '가입 전 이메일 OTP — 계정 없는 사용자의 진입점',
  'POST auth/signup-email-challenge/:id/confirm': '가입 전 이메일 OTP 확인',
  'GET auth/web-id-available': '가입 폼 아이디 중복 확인(열거 방지는 형식 검증·레이트리밋)',
  'POST auth/signup-phone-challenge': '가입 전 휴대전화 OTP',
  'POST auth/signup-phone-challenge/:id/confirm': '가입 전 휴대전화 OTP 확인',
  'GET auth/signup-config': '가입 폼 구성(필수 인증 채널) 조회',
  'POST auth/signup': '가입 신청(대표 승인 대기)',
  'GET auth/verify-email': '이메일 인증 링크(토큰 자체가 자격)',
  'POST auth/login': '로그인',
  'POST auth/refresh': '토큰 재발급(refresh 쿠키가 자격)',
  'POST auth/recover-id': '아이디 찾기(열거 방지 응답)',
  'POST auth/recover-password': '비밀번호 재설정 요청(열거 방지 응답)',
  'POST auth/reset-password': '비밀번호 재설정(토큰이 자격)',
  'POST auth/recovery-email-challenge': '복구용 이메일 OTP',
  'POST auth/recovery-email-challenge/:id/confirm': '복구용 이메일 OTP 확인',
  'POST auth/recover-id/complete': '아이디 찾기 완료(OTP 소비)',
  'POST auth/reset-password-otp': 'OTP 기반 비밀번호 재설정',
  'POST auth/logout': '로그아웃(쿠키 만료 — 토큰 만료 상태에서도 호출 가능해야 함)',
  'GET health': '가동 확인(무인증 모니터링)',
  'GET health/db': 'DB 연결 상태(민감정보 없는 상태 요약만 — 29B-2 규약)',
};

type RouteRecord = {
  label: string;
  file: string;
  line: number;
  policy: Policy | null;
  policySource: 'method' | 'class' | null;
};

function walkControllers(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkControllers(full, acc);
    else if (entry.endsWith('.controller.ts')) acc.push(full);
  }
  return acc;
}

function decoratorName(dec: ts.Decorator): string | null {
  const expr = dec.expression;
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) return expr.expression.text;
  if (ts.isIdentifier(expr)) return expr.text;
  return null;
}

function decoratorFirstStringArg(dec: ts.Decorator): string {
  const expr = dec.expression;
  if (ts.isCallExpression(expr) && expr.arguments.length > 0) {
    const arg = expr.arguments[0];
    if (ts.isStringLiteralLike(arg)) return arg.text;
  }
  return '';
}

function decoratorsOf(node: ts.HasDecorators): ts.Decorator[] {
  return [...(ts.getDecorators(node) ?? [])];
}

function policyOf(decorators: ts.Decorator[]): Policy | null {
  const names = decorators.map(decoratorName);
  // 우선순위: Public > RequireCapabilities > Roles (RolesGuard 판정 순서와 동일 축)
  for (const policy of POLICY_DECORATORS) if (names.includes(policy)) return policy;
  return null;
}

function collectRoutes(): RouteRecord[] {
  const routes: RouteRecord[] = [];
  for (const file of walkControllers(SRC_ROOT)) {
    const sourceText = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, sourceText, ts.ScriptTarget.ES2022, true);
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node)) {
        const classDecorators = decoratorsOf(node);
        const controllerDec = classDecorators.find((d) => decoratorName(d) === 'Controller');
        if (controllerDec) {
          const basePath = decoratorFirstStringArg(controllerDec);
          const classPolicy = policyOf(classDecorators);
          for (const member of node.members) {
            if (!ts.isMethodDeclaration(member)) continue;
            const methodDecorators = decoratorsOf(member);
            const httpDec = methodDecorators.find((d) => {
              const name = decoratorName(d);
              return name != null && HTTP_DECORATORS.has(name);
            });
            if (!httpDec) continue;
            const verb = decoratorName(httpDec)!.toUpperCase();
            const subPath = decoratorFirstStringArg(httpDec);
            const label = `${verb} ${[basePath, subPath].filter(Boolean).join('/')}` || `${verb} /`;
            const methodPolicy = policyOf(methodDecorators);
            routes.push({
              label,
              file: relative(join(__dirname, '..'), file),
              line: sf.getLineAndCharacterOfPosition(member.getStart()).line + 1,
              policy: methodPolicy ?? classPolicy,
              policySource: methodPolicy ? 'method' : classPolicy ? 'class' : null,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return routes;
}

function main(): void {
  const routes = collectRoutes();
  const undeclared = routes.filter((r) => r.policy == null);
  const publicRoutes = routes.filter((r) => r.policy === 'Public');
  const counts = {
    total: routes.length,
    public: publicRoutes.length,
    capabilities: routes.filter((r) => r.policy === 'RequireCapabilities').length,
    roles: routes.filter((r) => r.policy === 'Roles').length,
  };

  const failures: string[] = [];
  for (const r of undeclared) {
    failures.push(`정책 미선언 라우트: ${r.label} (${r.file}:${r.line}) — @Public | @Roles | @RequireCapabilities 중 하나를 선언하라`);
  }
  const publicLabels = new Set(publicRoutes.map((r) => r.label));
  for (const r of publicRoutes) {
    if (!(r.label in PUBLIC_ALLOWLIST)) {
      failures.push(`allowlist 밖 @Public 라우트: ${r.label} (${r.file}:${r.line}) — 의도된 공개라면 PUBLIC_ALLOWLIST에 사유와 함께 추가하라`);
    }
  }
  for (const label of Object.keys(PUBLIC_ALLOWLIST)) {
    if (!publicLabels.has(label)) {
      failures.push(`낡은 allowlist 항목: ${label} — 라우트가 사라졌거나 정책이 바뀌었다. allowlist에서 제거하라`);
    }
  }

  console.log(JSON.stringify({ ok: failures.length === 0, counts, failures }, null, 2));
  if (failures.length) process.exit(1);
}

main();
