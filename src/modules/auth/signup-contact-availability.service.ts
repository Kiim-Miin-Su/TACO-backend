import { ConflictException, Injectable } from '@nestjs/common';
import { normalizeContactTarget, tryNormalizePhone, type ContactChannel } from '../../common/contact-normalization';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { USERS_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { USERS, type StaffAccount } from '../users/user.entity';

/** 가입 연락처 중복 판정 단일 소스. 매 판정 전에 users를 권위 DB에서 다시 읽는다. */
@Injectable()
export class SignupContactAvailabilityService {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
  ) {}

  normalize(channel: ContactChannel, raw: string): string {
    return normalizeContactTarget(channel, raw);
  }

  async assertAvailable(channel: ContactChannel, raw: string, excludeUserId?: number): Promise<string> {
    const target = this.normalize(channel, raw);
    await this.store.hydrate<StaffAccount>(USERS_SPEC);
    this.assertAvailableInCurrentProjection(channel, target, excludeUserId);
    return target;
  }

  assertAvailableInCurrentProjection(channel: ContactChannel, normalized: string, excludeUserId?: number): void {
    const taken = this.db.findAll<StaffAccount>(USERS).some((account) => {
      if (account.id === excludeUserId) return false;
      if (channel === 'email') return account.email?.trim().toLowerCase() === normalized;
      return tryNormalizePhone(account.phone) === normalized;
    });
    if (!taken) return;

    const target = channel === 'email' ? '이메일' : '휴대폰';
    throw new ConflictException({
      statusCode: 409,
      code: channel === 'email' ? 'SIGNUP_EMAIL_ALREADY_REGISTERED' : 'SIGNUP_PHONE_ALREADY_REGISTERED',
      message: `이미 가입된 ${target}입니다.`,
    });
  }
}
