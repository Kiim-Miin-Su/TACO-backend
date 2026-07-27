import {
  ArgumentMetadata,
  BadRequestException,
  Injectable,
  PipeTransform,
} from '@nestjs/common';

export const POSTGRES_INTEGER_MAX = 2_147_483_647;

const CANONICAL_POSITIVE_INTEGER = /^[1-9]\d*$/;
const VALIDATION_MESSAGE =
  'Validation failed (positive PostgreSQL integer is expected)';

function parsePositiveInt(value: unknown): number {
  if (typeof value === 'number') {
    if (
      Number.isInteger(value) &&
      value >= 1 &&
      value <= POSTGRES_INTEGER_MAX
    ) {
      return value;
    }
    throw new BadRequestException(VALIDATION_MESSAGE);
  }

  if (
    typeof value !== 'string' ||
    !CANONICAL_POSITIVE_INTEGER.test(value)
  ) {
    throw new BadRequestException(VALIDATION_MESSAGE);
  }

  const parsed = Number(value);
  if (parsed > POSTGRES_INTEGER_MAX) {
    throw new BadRequestException(VALIDATION_MESSAGE);
  }
  return parsed;
}

@Injectable()
export class PositiveIntPipe implements PipeTransform<unknown, number> {
  transform(value: unknown): number {
    return parsePositiveInt(value);
  }
}

@Injectable()
export class OptionalPositiveIntPipe
  implements PipeTransform<unknown, number | undefined>
{
  transform(value: unknown): number | undefined {
    return value === undefined ? undefined : parsePositiveInt(value);
  }
}

export class OptionalBoundedIntPipe
  implements PipeTransform<unknown, number | undefined>
{
  constructor(
    private readonly minimum: number,
    private readonly maximum: number,
    private readonly fieldName: string,
  ) {}

  transform(value: unknown): number | undefined {
    if (value === undefined) return undefined;
    const parsed = parsePositiveInt(value);
    if (parsed < this.minimum || parsed > this.maximum) {
      throw new BadRequestException(
        `${this.fieldName} must be between ${this.minimum} and ${this.maximum}`,
      );
    }
    return parsed;
  }
}

/**
 * Runs before Nest's transforming ValidationPipe so canonical route text is not
 * lost when Number metadata converts values such as "01" or "1.0" to 1.
 */
@Injectable()
export class RawPositiveIntBoundaryPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (
      value !== undefined &&
      (metadata.type === 'param' || metadata.type === 'query') &&
      metadata.metatype === Number
    ) {
      parsePositiveInt(value);
    }
    return value;
  }
}
