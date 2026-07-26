// [TBO-30D/30E 2026-07-23 대표 지시] 상담 퍼널·상담↔수강 상관관계 집계의 **단일 진실원 순수 함수**.
//  payout-integrity와 같은 규약: API(GET /counsel/analytics/*)와 e2e가 이 함수 하나를 같이 소비한다
//  (집계 로직 사본 0). 입력은 읽기모델 스냅샷 — 원본 표 무변형(파생 전용), 신규 컬럼·사본 저장 0.
//  상관관계의 "희망"은 student_interests(학생 aggregate 권위), "등록"은 enrollments가 소스 —
//  counsel 폼에 희망 과목 사본 필드를 만들지 않는다(계약 0.2.17 studentId 필수 체계와 일관).
import type { CounselResult, CounselStatus } from '@kms545487/contracts';
import { COUNSEL_RESULTS, COUNSEL_STATUSES } from './counsel.entity'; // [P2 M5]

export type CounselAnalyticsSnapshot = {
  forms: Array<{ id: number; studentId: number; status: CounselStatus; createdAt: string }>;
  rounds: Array<{ counselFormId: number; roundNo: number; result?: CounselResult | null; completedAt?: string | null }>;
  interests: Array<{ studentId: number; courseId?: number | null; customLabel?: string | null }>;
  enrollments: Array<{ studentId: number; courseId: number; status: string }>;
  courses: Array<{ id: number; subjectId: number }>;
  subjects: Array<{ id: number; name: string }>;
};

export type CounselAnalyticsRange = { from?: string | null; to?: string | null };

export type CounselFunnel = {
  range: { from: string | null; to: string | null };
  total: number;
  /** 상태별 카드 수 — 라벨·톤은 FE labels.ts(단일 진실원)가 입힌다. */
  statusCounts: Record<CounselStatus, number>;
  /** 도달 퍼널 — n회차 이상 진행된 카드 수(0=접수만). 단계 이탈 시각화 소스. */
  roundReach: Array<{ minRounds: number; count: number }>;
  /** 미등록(dropped) 카드가 몇 회차에서 멈췄는가 — "어느 회차에서 놓치는가". */
  dropAfterRounds: Array<{ rounds: number; count: number }>;
  /** 기간 내 카드들의 회차 result 분포(회차 단위). */
  resultDistribution: Record<CounselResult, number>;
  conversionRate: number; // registered / total (total 0이면 0)
  dropRate: number;       // dropped / total
  avgRoundsToConversion: number | null; // 전환 카드의 (전환 회차 roundNo+1) 평균
  avgDaysToConversion: number | null;   // 접수일 → result='registered' 회차 완료일 평균(일)
};

import { dayOf as dateOnly } from '../../common/day-range'; // [TBO-34 C3] 날짜 파생 단일 진실원
const daysBetween = (fromIso: string, toIso: string): number =>
  Math.round((Date.parse(dateOnly(toIso)) - Date.parse(dateOnly(fromIso))) / 86_400_000);

const inRange = (createdAt: string, range: CounselAnalyticsRange): boolean => {
  const day = dateOnly(createdAt);
  if (range.from && day < range.from) return false;
  if (range.to && day > range.to) return false;
  return true;
};

const STATUSES: readonly CounselStatus[] = COUNSEL_STATUSES; // [P2 M5]
const RESULTS: readonly CounselResult[] = COUNSEL_RESULTS; // [P2 M5]

export function computeCounselFunnel(snapshot: CounselAnalyticsSnapshot, range: CounselAnalyticsRange = {}): CounselFunnel {
  const forms = snapshot.forms.filter((form) => inRange(form.createdAt, range));
  const formIds = new Set(forms.map((form) => form.id));
  const roundsByForm = new Map<number, CounselAnalyticsSnapshot['rounds']>();
  for (const round of snapshot.rounds) {
    if (!formIds.has(round.counselFormId)) continue;
    const bucket = roundsByForm.get(round.counselFormId) ?? [];
    bucket.push(round);
    roundsByForm.set(round.counselFormId, bucket);
  }

  const statusCounts = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<CounselStatus, number>;
  const resultDistribution = Object.fromEntries(RESULTS.map((result) => [result, 0])) as Record<CounselResult, number>;
  const roundCountOf = (formId: number) => roundsByForm.get(formId)?.length ?? 0;
  const maxRounds = forms.reduce((max, form) => Math.max(max, roundCountOf(form.id)), 0);

  const dropBuckets = new Map<number, number>();
  const conversionRounds: number[] = [];
  const conversionDays: number[] = [];
  for (const form of forms) {
    statusCounts[form.status] += 1;
    const rounds = (roundsByForm.get(form.id) ?? []).slice().sort((a, b) => a.roundNo - b.roundNo);
    for (const round of rounds) if (round.result) resultDistribution[round.result] += 1;
    if (form.status === 'dropped') {
      dropBuckets.set(rounds.length, (dropBuckets.get(rounds.length) ?? 0) + 1);
    }
    if (form.status === 'registered') {
      // 전환 시점 = result='registered'가 기록된 최초 회차(명시 마커가 있는 카드만 평균에 포함)
      const marker = rounds.find((round) => round.result === 'registered');
      if (marker) {
        conversionRounds.push(marker.roundNo + 1);
        if (marker.completedAt) conversionDays.push(Math.max(0, daysBetween(form.createdAt, marker.completedAt)));
      }
    }
  }

  const roundReach: Array<{ minRounds: number; count: number }> = [];
  for (let min = 0; min <= Math.max(maxRounds, 1); min += 1) {
    roundReach.push({ minRounds: min, count: forms.filter((form) => roundCountOf(form.id) >= min).length });
  }
  const avg = (values: number[]): number | null =>
    values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10 : null;

  return {
    range: { from: range.from ?? null, to: range.to ?? null },
    total: forms.length,
    statusCounts,
    roundReach,
    dropAfterRounds: [...dropBuckets.entries()].sort((a, b) => a[0] - b[0])
      .map(([rounds, count]) => ({ rounds, count })),
    resultDistribution,
    conversionRate: forms.length ? statusCounts.registered / forms.length : 0,
    dropRate: forms.length ? statusCounts.dropped / forms.length : 0,
    avgRoundsToConversion: avg(conversionRounds),
    avgDaysToConversion: avg(conversionDays),
  };
}

/** 희망 축의 특수 버킷 — 과목으로 정규화할 수 없는 관심(자유입력)·관심 미입력. */
export const CORRELATION_CUSTOM_KEY = '기타(자유입력)';
export const CORRELATION_NONE_KEY = '희망 미입력';

export type CounselCorrelationRow = {
  interestKey: string;      // 희망 과목명(subjects 조인) 또는 특수 버킷
  counselCount: number;     // 이 희망을 가진 상담 카드 수
  convertedCount: number;   // 그중 등록 전환(status='registered') 카드 수
  conversionRate: number;   // convertedCount / counselCount
  /** 전환 카드 학생들의 실제 등록 과목 분포(enrollments 조인, canceled 제외) — "SAT 문의 → TOEFL 등록" 가시화. */
  enrolledBySubject: Array<{ subject: string; count: number }>;
};

export type CounselCorrelation = {
  range: { from: string | null; to: string | null };
  totalForms: number;
  rows: CounselCorrelationRow[];       // counselCount desc 정렬
  enrolledSubjects: string[];          // 열 구성용 — 등장한 등록 과목명(count 합 desc)
};

export function computeCounselCorrelation(
  snapshot: CounselAnalyticsSnapshot,
  range: CounselAnalyticsRange = {},
): CounselCorrelation {
  const subjectNameById = new Map(snapshot.subjects.map((subject) => [subject.id, subject.name]));
  const subjectOfCourse = (courseId: number): string => {
    const course = snapshot.courses.find((c) => c.id === courseId);
    return (course && subjectNameById.get(course.subjectId)) ?? '기타';
  };
  const forms = snapshot.forms.filter((form) => inRange(form.createdAt, range));

  // 학생별 파생(조인) — 희망 과목 집합(student_interests 권위), 등록 과목 집합(enrollments 권위)
  const interestSubjectsOf = (studentId: number): string[] => {
    const keys = new Set<string>();
    for (const interest of snapshot.interests.filter((i) => i.studentId === studentId)) {
      if (interest.courseId != null) keys.add(subjectOfCourse(interest.courseId));
      else if (interest.customLabel) keys.add(CORRELATION_CUSTOM_KEY);
    }
    return keys.size ? [...keys] : [CORRELATION_NONE_KEY];
  };
  const enrolledSubjectsOf = (studentId: number): string[] => {
    const keys = new Set<string>();
    for (const enrollment of snapshot.enrollments.filter((e) => e.studentId === studentId && e.status !== 'canceled')) {
      keys.add(subjectOfCourse(enrollment.courseId));
    }
    return [...keys];
  };

  const rowByKey = new Map<string, { counselCount: number; convertedCount: number; enrolled: Map<string, number> }>();
  for (const form of forms) {
    const converted = form.status === 'registered';
    const enrolled = converted ? enrolledSubjectsOf(form.studentId) : [];
    for (const key of interestSubjectsOf(form.studentId)) {
      const row = rowByKey.get(key) ?? { counselCount: 0, convertedCount: 0, enrolled: new Map<string, number>() };
      row.counselCount += 1;
      if (converted) {
        row.convertedCount += 1;
        for (const subject of enrolled) row.enrolled.set(subject, (row.enrolled.get(subject) ?? 0) + 1);
      }
      rowByKey.set(key, row);
    }
  }

  const columnTotals = new Map<string, number>();
  const rows: CounselCorrelationRow[] = [...rowByKey.entries()]
    .map(([interestKey, row]) => {
      for (const [subject, count] of row.enrolled) columnTotals.set(subject, (columnTotals.get(subject) ?? 0) + count);
      return {
        interestKey,
        counselCount: row.counselCount,
        convertedCount: row.convertedCount,
        conversionRate: row.counselCount ? row.convertedCount / row.counselCount : 0,
        enrolledBySubject: [...row.enrolled.entries()].sort((a, b) => b[1] - a[1])
          .map(([subject, count]) => ({ subject, count })),
      };
    })
    .sort((a, b) => b.counselCount - a.counselCount || a.interestKey.localeCompare(b.interestKey));

  return {
    range: { from: range.from ?? null, to: range.to ?? null },
    totalForms: forms.length,
    rows,
    enrolledSubjects: [...columnTotals.entries()].sort((a, b) => b[1] - a[1]).map(([subject]) => subject),
  };
}
