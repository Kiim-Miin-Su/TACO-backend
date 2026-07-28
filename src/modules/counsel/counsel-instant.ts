import { applyDecorators } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, Matches } from 'class-validator';

export const COUNSEL_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export const COUNSEL_INSTANT_MESSAGE =
  'nextContactAt must be an ISO 8601 datetime with timezone';

export const normalizeCounselInstant = (
  value: string | null | undefined,
): string | null | undefined =>
  value == null ? value : new Date(value).toISOString();

/** 런타임 검증과 OpenAPI가 같은 다음 상담 예정 instant 계약을 사용한다. */
export function CounselInstantField(options: {
  nullable?: boolean;
} = {}): PropertyDecorator {
  const validate: PropertyDecorator = (target, propertyKey) => {
    const propertyName = String(propertyKey);
    IsISO8601(
      { strict: true, strictSeparator: true },
      { message: COUNSEL_INSTANT_MESSAGE },
    )(target, propertyName);
    Matches(COUNSEL_INSTANT_PATTERN, { message: COUNSEL_INSTANT_MESSAGE })(
      target,
      propertyName,
    );
  };
  return applyDecorators(
    ApiPropertyOptional({
      type: String,
      format: 'date-time',
      pattern: COUNSEL_INSTANT_PATTERN.source,
      example: '2026-07-28T09:30:00+09:00',
      nullable: options.nullable ?? false,
    }),
    validate,
  );
}
