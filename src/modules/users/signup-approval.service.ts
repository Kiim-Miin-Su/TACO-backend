import type { StaffAccountDetail } from '@kms545487/contracts';
// [TBO-68 C3 2026-07-26] 가입 승인·직접 등록 서비스 — users.service에서 승인 컨텍스트 분리(P3 ①).
//  표면: 승인센터 5라우트(auth.controller — listPending/approve/resend/reject/delete)와
//  대표 직접 등록(users·instructors.controller). **public API·규약 무변**(본문 이동만):
//  CAS(status='pending')·같은 tx의 users+instructor_profiles+audit·auth_version+1 전부 유지.
//  계정 코어(미러 refresh·find)는 UsersService 단방향 주입 경유(순환 없음).
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { USERS_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { AuditService } from '../audit/audit.service';
import { canDecideSignupRole, roleHasCapability } from '../auth/role-policy';
import { InstructorProfilesStore } from './instructor-profiles.store';
import {
  USERS, authVersionOf, rrnMaskedOf, toSafe,
  type SafeAccount, type StaffAccount, type StaffRole,
} from './user.entity';
import { UsersService, identityLockId } from './users.service';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

@Injectable()
export class SignupApprovalService {
  constructor(
    private readonly users: UsersService,
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
    private readonly uow: CalendarUnitOfWork,
    private readonly audit: AuditService,
    private readonly profiles: InstructorProfilesStore,
  ) {}

  async listPending(actorId: number): Promise<StaffAccountDetail[]> {
    await this.users.refreshFromDb(); // [28F] 다른 인스턴스의 신규 가입이 대표 대기목록에 즉시 반영
    const actor = this.signupDecisionActor(actorId);
    // [TBO-31 C1 D2] 승인 판단 근거로 rrnMasked('950101-1******')만 노출 — 평문·암호문은 응답에 없다.
    //  birthYear(파생값)는 SafeAccount에 그대로 유지(기존 승인센터 표시 소비처).
    return this.db.findBy<StaffAccount>(USERS, (a) =>
      a.status === 'pending' && a.deletedAt == null && canDecideSignupRole(actor.role, a.role)).map((a) => ({
      ...toSafe(a),
      rrnMasked: rrnMaskedOf(a),
    }));
  }

  private signupDecisionActor(actorId: number): StaffAccount {
    const actor = this.users.findById(actorId);
    if (!actor || actor.status !== 'active' || actor.deletedAt != null || !roleHasCapability(actor.role, 'signup.decide'))
      throw new ForbiddenException('활성 관리자만 가입 신청을 처리할 수 있습니다.');
    return actor;
  }

  private assertSignupDecisionScope(actorId: number, target: StaffAccount): void {
    const actor = this.signupDecisionActor(actorId);
    if (!canDecideSignupRole(actor.role, target.role))
      throw new ForbiddenException('해당 역할의 가입 신청을 처리할 권한이 없습니다.');
  }

  // ── [TBO-28B] 승인/반려 — 원자적 승인 command ────────────────────────────────
  //  · actor = 검증된 JWT sub만(바디 위조 불가 — 불변식 §5-4). reason은 audit_log에 남는다.
  //  · CAS(조건부 update: status='pending')로 동시 approve/approve·approve/reject 중 **한 command만 성공**(나머지 409).
  //  · users + instructor_profiles + audit_log가 **같은 트랜잭션**(CalendarUnitOfWork: 메모리 스냅샷 ⊃ pg tx).
  //  · auth_version +1 → 상태/역할 변경 즉시 기존 JWT 무효(AccountStateService 대조).

  async approve(id: number, actorId: number, reason?: string): Promise<SafeAccount> {
    await this.users.refreshFromDb(); // [28F] 사전 조회(authVersion 등) 정합 — 최종 판정은 CAS가 권위
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'user', id }, { kind: 'user', id: actorId }]);
      await this.users.refreshFromDb();
      const before = this.users.findById(id);
      if (!before) throw new NotFoundException(`계정 ${id} 없음`);
      this.assertSignupDecisionScope(actorId, before);
      const finalRole: StaffRole = before.role;
      const approvedAt = new Date().toISOString();
      const updated = await this.store.updateIf<StaffAccount>(
        USERS_SPEC, id,
        { status: 'pending', emailVerified: true },
        {
          status: 'active', role: finalRole,
          approvedBy: actorId, approvedAt,
          authVersion: authVersionOf(before) + 1,
        },
      );
      if (!updated) {
        const cur = this.users.findById(id);
        if (cur && !cur.emailVerified) throw new ForbiddenException('이메일 인증이 완료되지 않은 계정은 승인할 수 없습니다.');
        throw new ConflictException('이미 처리된 계정입니다(대기 상태가 아님).');
      }
      // 불변식: active instructor ↔ active instructor_profiles 정확 1행.
      // [E0.5 ④b] 가입 폼 제공 정보(대학·전공·출생연도)를 같은 tx에서 프로필로 승계(COALESCE upsert).
      if (updated.role === 'instructor') {
        const profile = await this.profiles.upsertActive(id, actorId, approvedAt, {
          university: updated.university ?? null,
          major: updated.major ?? null,
          birthYear: updated.birthYear ?? null,
        });
        await this.audit.log({ entity: 'instructor_profiles', entityId: id, action: 'create', actorId,
          changes: this.audit.maskContactPii(this.audit.snapshotOf(profile)), reason: '가입 승인 강사 프로필 생성' });
      }
      await this.audit.log({
        entity: 'users', entityId: id, action: 'approve', actorId,
        changes: {
          status: { before: 'pending', after: 'active' },
        },
        reason,
      });
      return toSafe(updated);
    });
  }

  // ── [운영 흐름 2026-07-14 대표 공지] 강사 직접 등록 — 대표가 받은 정보(이름·나이·대학교·전공·전화·아이디·비번)로
  //  즉시 active 계정 생성(가입승인 흐름과 동일 기계: users + instructor_profiles + audit 단일 tx).
  //  이메일 인증 생략(직접 신원 확인 전제). 학생·수업 추가는 기존 웹 화면 흐름.
  async provisionInstructor(
    input: {
      webId: string; name: string; password: string;
      email?: string; phone?: string; university?: string; major?: string; birthYear?: number;
      countryCode?: string; timeZone?: string;
      defaultHourlyRate?: number; canTeachKinder?: boolean;
      role?: 'instructor' | 'manager' | 'admin'; // [유저 관리 07-20] 역할 확장(기본 instructor)
    },
    actorId: number,
  ): Promise<SafeAccount> {
    await this.users.refreshFromDb(); // [28F] 교차 인스턴스 중복 검사 정합
    const webId = input.webId.trim();
    const email = input.email?.trim().toLowerCase() || null;
    if (webId.length < 3) throw new BadRequestException('아이디는 3자 이상이어야 합니다.');
    if (input.password.length < 8) throw new BadRequestException('비밀번호는 8자 이상이어야 합니다.');
    if (this.users.findByWebId(webId)) throw new BadRequestException('이미 사용 중인 아이디입니다.');
    if (email && this.db.findBy<StaffAccount>(USERS, (a) => !!a.email && a.email.toLowerCase() === email).length)
      throw new BadRequestException('이미 사용 중인 이메일입니다.');
    const passwordHash = await bcrypt.hash(input.password, 12);
    if (this.users.findByWebId(webId)) throw new BadRequestException('이미 사용 중인 아이디입니다.'); // [M1] TOCTOU 재검증
    const role: 'instructor' | 'manager' | 'admin' = input.role ?? 'instructor';
    return this.uow.run(async () => {
      // 최종 중복/actor 판정은 bcrypt 이전 cache가 아니라 identity lock 뒤 Postgres readback이 권위다.
      await this.uow.lockTargets([
        { kind: 'loginIdentity', id: identityLockId(webId) },
        { kind: 'user', id: actorId },
      ]);
      await this.users.refreshFromDb();
      if (this.users.findByWebId(webId)) throw new BadRequestException('이미 사용 중인 아이디입니다.');
      if (email && this.db.findBy<StaffAccount>(USERS, (account) =>
        !!account.email && account.email.toLowerCase() === email).length) {
        throw new BadRequestException('이미 사용 중인 이메일입니다.');
      }
      const approvedAt = new Date().toISOString();
      const acc = await this.store.insert<StaffAccount>(USERS_SPEC, {
        webId, name: input.name.trim(), email, phone: input.phone?.trim() || null,
        role, status: 'active', passwordHash,
        emailVerified: true, // 직접 등록 — 인증 게이트 생략(로그인 게이트 통과용)
        approvedBy: actorId, approvedAt, authVersion: 1,
        profileVersion: 1,
        countryCode: input.countryCode, timeZone: input.timeZone,
      });
      if (role === 'instructor') {
        // 강사 프로필은 강사 역할만(E0.5 ④b 승계 규약과 동일 기계).
        const profile = await this.profiles.upsertActive(acc.id, actorId, approvedAt, {
          university: input.university?.trim() || null,
          major: input.major?.trim() || null,
          birthYear: input.birthYear ?? null,
          defaultHourlyRate: input.defaultHourlyRate ?? 0,
          canTeachKinder: input.canTeachKinder ?? false,
        });
        await this.audit.log({ entity: 'instructor_profiles', entityId: acc.id, action: 'create', actorId,
          changes: this.audit.maskContactPii(this.audit.snapshotOf(profile)), reason: '대표 직접 강사 프로필 생성' });
      }
      await this.audit.log({
        entity: 'users', entityId: acc.id, action: 'create', actorId,
        changes: { status: { after: 'active' }, role: { after: role } },
        reason: '대표 직접 등록',
      });
      return toSafe(acc);
    });
  }

  async reject(id: number, actorId: number, reason: string): Promise<SafeAccount> {
    await this.users.refreshFromDb(); // [28F]
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'user', id }, { kind: 'user', id: actorId }]);
      await this.users.refreshFromDb();
      const before = this.users.findById(id);
      if (!before) throw new NotFoundException(`계정 ${id} 없음`);
      this.assertSignupDecisionScope(actorId, before);
      const updated = await this.store.updateIf<StaffAccount>(
        USERS_SPEC, id,
        { status: 'pending' },
        { status: 'rejected', authVersion: authVersionOf(before) + 1 },
      );
      if (!updated) throw new ConflictException('이미 처리된 계정입니다(대기 상태가 아님).');
      await this.audit.log({
        entity: 'users', entityId: id, action: 'reject', actorId,
        changes: { status: { before: 'pending', after: 'rejected' } },
        reason,
      });
      return toSafe(updated);
    });
  }

  // [핫픽스 2026-07-20 대표 보고] 가입 신청 삭제 — pending/rejected 계정을 정리한다.
  //  users.web_id/email은 하드 UNIQUE(부분 인덱스 아님)라 반려·soft delete만으로는 같은 아이디/이메일
  //  재가입이 영구히 막힌다("삭제가 안 된다"의 실체). 삭제 = 식별자 tombstone 해제 + RRN 즉시 파기
  //  (개보법 수집 최소화 — 반려 계정 RRN 보존 기한 문제도 함께 해소) + soft delete + audit(사유 필수).
  async deletePendingAccount(id: number, actorId: number, reason: string): Promise<{ ok: true }> {
    await this.users.refreshFromDb();
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'user', id }, { kind: 'user', id: actorId }]);
      await this.users.refreshFromDb();
      const before = this.users.findById(id);
      if (!before) throw new NotFoundException(`계정 ${id} 없음`);
      if (before.status !== 'pending' && before.status !== 'rejected')
        throw new BadRequestException('가입 대기(pending)·반려(rejected) 계정만 삭제할 수 있습니다.');
      const tombstone = `del_${id}_${Date.now().toString(36)}`.slice(0, 50); // UNIQUE 해제(50자 상한)
      const tombstoned = await this.store.updateIf<StaffAccount>(USERS_SPEC, id, {
        status: before.status,
        webId: before.webId,
      }, {
        webId: tombstone,
        email: null, // email UNIQUE는 NULL 다중 허용 — 원 이메일 즉시 재가입 가능
        rrnEncrypted: null, // 개인정보 파기(마스킹 포함 일절 잔존 금지)
        emailVerifyTokenHash: null,
        emailVerifyExpiresAt: null,
        passwordResetTokenHash: null,
        passwordResetExpiresAt: null,
        authVersion: authVersionOf(before) + 1,
      } as Partial<StaffAccount> as never);
      if (!tombstoned) {
        throw new ConflictException('가입 신청 상태가 변경되었습니다. 목록을 새로고침해 주세요.');
      }
      await this.store.remove(USERS_SPEC, id, actorId);
      // audit — 원 식별자는 사유 추적을 위해 webId만 기록(email·RRN은 기록하지 않는다).
      await this.audit.log({
        entity: 'users', entityId: id, action: 'delete', actorId,
        changes: { webId: { before: before.webId, after: tombstone }, status: { before: before.status, after: '[deleted]' } },
        reason,
      });
      return { ok: true as const };
    });
  }

  async resendVerificationEmail(id: number, actorId: number): Promise<{ account: SafeAccount; verifyToken: string }> {
    await this.users.refreshFromDb();
    const acc = this.users.findById(id);
    if (!acc || acc.status !== 'pending') throw new NotFoundException('승인 대기 계정이 아닙니다.');
    if (acc.emailVerified === true) throw new BadRequestException('이미 이메일 인증이 완료된 계정입니다.');
    if (!acc.email) throw new BadRequestException('계정에 이메일이 없습니다.');
    const verifyToken = randomBytes(24).toString('hex');
    return this.uow.run(async () => {
      const updated = await this.store.update<StaffAccount>(USERS_SPEC, id, {
        emailVerifyTokenHash: sha256(verifyToken),
        emailVerifyExpiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(), // 48h(가입 링크 관례)
      } as Partial<StaffAccount> as never);
      if (!updated) throw new NotFoundException('승인 대기 계정이 아닙니다.');
      await this.audit.log({
        entity: 'users', entityId: id, action: 'update', actorId,
        changes: { emailVerifyToken: { before: '[redacted]', after: '[reissued]' } },
        reason: '이메일 인증 메일 재발송(대표 — 레거시 pending 구제)',
      });
      return { account: toSafe(updated), verifyToken };
    });
  }
}
