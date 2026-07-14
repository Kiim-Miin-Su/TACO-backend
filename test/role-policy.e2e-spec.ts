import {
  isInstructorOnly,
  isStaffRole,
  roleHasCapability,
} from '../src/modules/auth/role-policy';

describe('role policy', () => {
  it('keeps students and parents outside backoffice login roles', () => {
    expect(isStaffRole('instructor')).toBe(true);
    expect(isStaffRole('student')).toBe(false);
    expect(isStaffRole('parent')).toBe(false);
  });

  it('keeps finance and signup decisions CEO-only', () => {
    expect(roleHasCapability('super_admin', 'finance.access')).toBe(true);
    expect(roleHasCapability('super_admin', 'signup.decide')).toBe(true);
    expect(roleHasCapability('admin', 'finance.access')).toBe(false);
    expect(roleHasCapability('manager', 'signup.decide')).toBe(false);
  });

  it('allows all admin roles to manage approvals and calendars', () => {
    for (const role of ['super_admin', 'admin', 'manager']) {
      expect(roleHasCapability(role, 'approval.manage')).toBe(true);
      expect(roleHasCapability(role, 'calendar.manage')).toBe(true);
    }
    expect(roleHasCapability('instructor', 'calendar.manage')).toBe(false);
  });

  it('detects instructor-only claims without granting mixed admin claims', () => {
    expect(isInstructorOnly(['instructor'])).toBe(true);
    expect(isInstructorOnly(['instructor', 'manager'])).toBe(false);
  });
});
