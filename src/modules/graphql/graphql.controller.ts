import { Logger, BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import { todayKst } from '../../common/time.util'; // [TBO-65 M2]
import { isProduction } from '../../common/env'; // [TBO-34 C3] 환경 판정 단일 진실원
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  GraphQLError, NoSchemaIntrospectionCustomRule, graphql, parse, specifiedRules, validate,
  type DocumentNode, type SelectionSetNode,
} from 'graphql';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { DbAnalyticsSnapshotRepository } from '../../database/db-analytics-snapshot.repository';
import { CounselService } from '../counsel/counsel.service';
import { PayoutsReadService } from '../payouts/payouts-read.service'; // [TBO-69 C2] 읽기만 소비
import { assertDayRange } from '../../common/day-range';
import { schema } from './graphql.schema';
import { computeCeoDashboard, computeFinanceSummary, computeRevenueReport } from './revenue-analytics';

const MAX_DEPTH = 6;

/** SelectionSet 중첩 깊이 — 남용(과도 중첩) 방어. 스키마가 얕아 정상 쿼리는 3~4 수준. */
function maxDepthOf(doc: DocumentNode): number {
  let max = 0;
  const walkSet = (set: SelectionSetNode | undefined, depth: number): void => {
    if (!set) return;
    max = Math.max(max, depth);
    for (const selection of set.selections) {
      if ('selectionSet' in selection) walkSet(selection.selectionSet, depth + 1);
    }
  };
  for (const def of doc.definitions) {
    if (def.kind === 'OperationDefinition') walkSet(def.selectionSet, 1);
  }
  return max;
}

const ceoLogger = new Logger('analytics'); // [TBO-60] 기간 파라미터 로그(§4 관측성)

/**
 * [TBO-46 G1 2026-07-23] GraphQL 매출·경영 조회 게이트웨이 — **읽기 전용**(스키마에 Mutation 없음),
 * 대표(super_admin) 전용, 기존 쿠키 인증·전역 가드 위에서 동작. 리졸버는 계산하지 않는다 —
 * counsel-analytics·payouts.uncovered·revenue-analytics(순수 함수)를 소비만 한다(집계 사본 0).
 * production은 introspection 거부(스키마 권위 = TBO-46 문서 §4 SDL).
 */
@ApiTags('graphql')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('graphql')
export class GraphqlGatewayController {
  constructor(
    private readonly analytics: DbAnalyticsSnapshotRepository, // [TBO-54 C2] P0-4 — DB 단일 snapshot
    private readonly counsel: CounselService,
    private readonly payouts: PayoutsReadService,
  ) {}

  @Post()
  @Roles('super_admin')
  @ApiOperation({ summary: 'GraphQL 매출·경영 조회(읽기 전용·대표 전용) — revenueReport/financeSummary/counselFunnel/counselCorrelation/uncoveredPayouts. Mutation 없음, production introspection 차단. [대표]' })
  async execute(@Body() body: { query?: string; variables?: Record<string, unknown>; operationName?: string }) {
    const source = body?.query;
    if (!source || typeof source !== 'string') throw new BadRequestException('query 문자열이 필요합니다.');

    let document: DocumentNode;
    try {
      document = parse(source);
    } catch (caught) {
      throw new BadRequestException(`GraphQL 구문 오류: ${(caught as GraphQLError).message}`);
    }
    const rules = isProduction() ? [...specifiedRules, NoSchemaIntrospectionCustomRule] : specifiedRules;
    const validationErrors = validate(schema, document, rules);
    if (validationErrors.length) {
      throw new BadRequestException({ message: 'GraphQL 검증 실패', errors: validationErrors.map((e) => e.message) });
    }
    if (maxDepthOf(document) > MAX_DEPTH) {
      throw new BadRequestException(`쿼리 깊이는 ${MAX_DEPTH}를 넘을 수 없습니다.`);
    }

    const keyCount = (record: Record<string, number>) =>
      Object.entries(record).map(([key, count]) => ({ key, count }));
    const range = (args: { from?: string | null; to?: string | null }) => {
      const value = { from: args.from ?? null, to: args.to ?? null };
      assertDayRange(value); // REST 분석과 같은 규칙(단일 진실원)
      return value;
    };

    // [TBO-58 P2 §4] 전 분석 쿼리 파라미터 로그 단일 지점 — "잘못된 입력 vs 집계 버그" 구분.
    //  allowlist(쿼리명·기간·months만 — 결과·PII 없음). rid는 RidConsoleLogger가 자동 첨부.
    const logged = <A extends { from?: string | null; to?: string | null; months?: number }, R>(
      name: string, fn: (args: A) => R,
    ) => (args: A): R => {
      ceoLogger.log(`query=${name} from=${args?.from ?? '-'} to=${args?.to ?? '-'}${args?.months != null ? ` months=${args.months}` : ''}`);
      return fn(args);
    };

    const rootValue = {
      // [TBO-54 C2] 스냅샷 = DB 저장소(REPEATABLE READ 한 tx) — 프로세스 메모리 projection 금지(P0-4).
      revenueReport: logged('revenueReport', async (args: { from?: string; to?: string }) =>
        computeRevenueReport(await this.analytics.revenue(), range(args))),
      financeSummary: logged('financeSummary', async (args: { from?: string; to?: string }) =>
        computeFinanceSummary(await this.analytics.revenue(), range(args))),
      counselFunnel: logged('counselFunnel', async (args: { from?: string; to?: string }) => {
        const funnel = await this.counsel.funnel(range(args)); // REST와 같은 서비스 경로
        return {
          ...funnel,
          statusCounts: keyCount(funnel.statusCounts as unknown as Record<string, number>),
          roundReach: funnel.roundReach.map((row) => ({ rounds: row.minRounds, count: row.count })),
        };
      }),
      counselCorrelation: logged('counselCorrelation', async (args: { from?: string; to?: string }) => {
        const correlation = await this.counsel.correlation(range(args));
        return {
          ...correlation,
          rows: correlation.rows.map((row) => ({
            ...row,
            enrolledBySubject: row.enrolledBySubject.map((cell) => ({ key: cell.subject, count: cell.count })),
          })),
        };
      }),
      uncoveredPayouts: logged('uncoveredPayouts', (args: { months?: number }) => this.payouts.uncoveredFresh(args.months ?? undefined)), // [TBO-56 C2b]
      // [TBO-60 2026-07-24] 대표 대시보드 — 한 snapshot(REPEATABLE READ)에서 D1(finance)+D2+D3+D6 파생.
      ceoDashboard: logged('ceoDashboard', async (args: { from?: string; to?: string }) => {
        const value = range(args);
        const snapshot = await this.analytics.revenue();
        return computeCeoDashboard(snapshot, value, todayKst()); // [TBO-65 M2] aging 기준일 = KST
      }),
    };

    const result = await graphql({
      schema, source, rootValue,
      variableValues: body.variables, operationName: body.operationName,
    });
    if (result.errors?.length) {
      // BadRequestException(HttpException)은 그대로 전파 — 내부 구조는 노출하지 않는다.
      const messages = result.errors.map((e) => e.originalError instanceof BadRequestException
        ? String((e.originalError.getResponse() as { message?: string }).message ?? e.message)
        : e.message);
      throw new BadRequestException({ message: 'GraphQL 실행 실패', errors: messages });
    }
    return result;
  }
}
