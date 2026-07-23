// [TBO-46 G1 2026-07-23] GraphQL 스키마 SDL — TBO-46 문서 §4와 같은 문자열이 권위(문서=구현).
//  Mutation 타입 자체가 없다(읽기 전용 게이트웨이 — 쓰기는 REST command가 유일 경로).
import { buildSchema } from 'graphql';

export const SDL = /* GraphQL */ `
type Query {
  revenueReport(from: String, to: String): RevenueReport!
  financeSummary(from: String, to: String): FinanceSummary!
  counselFunnel(from: String, to: String): CounselFunnel!
  counselCorrelation(from: String, to: String): CounselCorrelation!
  uncoveredPayouts(months: Int): [UncoveredPayout!]!
}
type RevenueReport { from: String to: String realizedTotal: Int! unpaidTotal: Int! unpaidCount: Int!
  byMonth: [KeyAmount!]! bySubject: [KeyAmount!]! byCourse: [KeyAmount!]! byStudent: [KeyAmount!]! }
type KeyAmount { key: String! amount: Int! count: Int! }
type FinanceSummary { from: String to: String revenue: Int! expenses: Int! payouts: Int! net: Int! }
type CounselFunnel { total: Int! conversionRate: Float! dropRate: Float!
  avgRoundsToConversion: Float avgDaysToConversion: Float
  statusCounts: [KeyCount!]! roundReach: [ReachCount!]! dropAfterRounds: [ReachCount!]! }
type KeyCount { key: String! count: Int! }
type ReachCount { rounds: Int! count: Int! }
type CounselCorrelation { totalForms: Int! enrolledSubjects: [String!]! rows: [CorrelationRow!]! }
type CorrelationRow { interestKey: String! counselCount: Int! convertedCount: Int!
  conversionRate: Float! enrolledBySubject: [KeyCount!]! }
type UncoveredPayout { instructorId: Int! instructorName: String! instructorStatus: String!
  month: String! sessionCount: Int! computedAmount: Int! }
`;

export const schema = buildSchema(SDL);
