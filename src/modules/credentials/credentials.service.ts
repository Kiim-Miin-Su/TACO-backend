// [E0 2026-07-15] 자격증명 변경 오케스트레이터 — UsersService(계정)와 ProfileVerificationsService
//  (이메일 OTP)를 **한 uow tx**로 묶는다. Users↔ProfileVerifications 모듈 순환을 피하기 위한
//  제3 모듈(ProfileChangeRequestsModule 선례와 동일 구조 — RegistrationsModule 참조).
//
//  정책(대표 참고사항 2026-07-15):
//  · 평시 비밀번호 변경 = 현재 비밀번호 재확인 + **본인 현재 이메일 OTP 소비**(같은 tx — 소비 실패
//    시 비밀번호 변경까지 롤백). SMS는 provider 유예 규약(§13.87) 그대로 — 이메일만 우선.
//  · 첫 로그인 강제 변경(must_change_password)은 예외 — 부트스트랩/리셋 컨텍스트(OTP 불요,
//    아이디+비밀번호+프로필 통합 설정 E0.5 ⑥ 유지).
//  · 아이디(webId) 즉시 변경 폐지(승인제) 검증은 UsersService.changeCredentials가 수행.
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { UsersService } from '../users/users.service';
import type { SafeAccount } from '../users/user.entity';
import { ProfileVerificationsService } from '../profile-verifications/profile-verifications.service';
import { ChangeCredentialsDto } from '../users/dto/change-credentials.dto';

@Injectable()
export class CredentialsService {
  constructor(
    private readonly uow: CalendarUnitOfWork,
    private readonly users: UsersService,
    private readonly verifications: ProfileVerificationsService,
  ) {}

  async change(id: number, dto: ChangeCredentialsDto): Promise<SafeAccount> {
    await this.users.refreshFromDb();
    return this.uow.run(async () => {
      // 잠금은 changeCredentials(중첩 run=같은 tx)가 결정적 순서로 획득한다 — 여기서는 판정만.
      const before = this.users.findById(id);
      if (!before) throw new NotFoundException(`계정 ${id} 없음`);
      const otpRequired = !!dto.newPassword && !before.mustChangePassword;
      const email = before.email?.trim().toLowerCase() ?? '';
      if (otpRequired) {
        if (!email) {
          throw new BadRequestException('등록된 이메일이 없어 비밀번호를 변경할 수 없습니다. 먼저 프로필에서 이메일을 등록해 주세요.');
        }
        if (dto.verificationChallengeId == null) {
          throw new BadRequestException('비밀번호 변경에는 본인 이메일 인증(verificationChallengeId)이 필요합니다.');
        }
      }
      // [대표 추가요청 2026-07-16] 첫 로그인 통합 설정도 **설정할 이메일**의 OTP 인증 필수 —
      //  종전 "부트스트랩 예외(무인증 + emailVerified=true 부여)"를 폐지한다. 인증 없이 오타 이메일이
      //  verified로 박히면 비밀번호 찾기·알림이 전부 죽은 주소로 가는 위험이 있었다.
      const rotationEmail = before.mustChangePassword ? dto.email?.trim().toLowerCase() ?? '' : '';
      if (rotationEmail && dto.verificationChallengeId == null) {
        throw new BadRequestException('설정할 이메일의 인증(verificationChallengeId)이 필요합니다. 인증 코드 발송 → 코드 확인 후 제출해 주세요.');
      }
      const account = await this.users.changeCredentials(id, dto);
      // OTP 소비는 변경 성공 **후** 같은 tx — 잘못된 현재 비밀번호 등으로 실패하면 챌린지가 타지 않고,
      //  소비가 실패하면(만료/불일치/이중 소비) 비밀번호 변경까지 함께 롤백된다(부분 상태 없음).
      if (otpRequired) {
        await this.verifications.consumeForCredentialChange(dto.verificationChallengeId!, id, email);
      } else if (rotationEmail) {
        // 강제 변경: challenge 대상 = **새로 설정하는 이메일**(본인 소유 실증) — 같은 tx 소비.
        await this.verifications.consumeForCredentialChange(dto.verificationChallengeId!, id, rotationEmail);
      }
      return account;
    });
  }
}
