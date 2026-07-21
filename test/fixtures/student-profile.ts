import type { CreateStudentAggregateInput, CreateStudentInput, StudentInterestInput } from '@kms545487/contracts';

export function studentAggregateBody(
  name: string,
  options: { student?: Partial<CreateStudentInput>; interests?: StudentInterestInput[] } = {},
): CreateStudentAggregateInput {
  const country = options.student?.country ?? 'KR';
  return {
    student: {
      name,
      gender: 'undisclosed',
      birthDate: '2012-07-21',
      grade: 8,
      country,
      residenceType: country === 'KR' ? 'domestic' : 'overseas',
      address: country === 'KR' ? '서울시' : 'Overseas address',
      schoolName: 'TACO School',
      phone: country === 'KR' ? '010-9000-0000' : '+1-206-555-0100',
      ...(country === 'KR' ? {} : { kakaoId: 'test-kakao' }),
      counselTopic: '학습 상담',
      status: 'new_inquiry',
      ...options.student,
    },
    interests: options.interests ?? [
      { courseId: 10, priority: 1 },
      { customLabel: `${name} 희망 수업`, priority: 2 },
    ],
  };
}
