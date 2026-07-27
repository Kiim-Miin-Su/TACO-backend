import {
  canDecideSignupRole,
  claimsHaveCapability,
  isInstructorOnly,
  isStaffRole,
  roleHasCapability,
  rolesForCapability,
} from '../src/modules/auth/role-policy';

describe('role policy', () => {
  it('keeps students and parents outside backoffice login roles', () => {
    expect(isStaffRole('instructor')).toBe(true);
    expect(isStaffRole('student')).toBe(false);
    expect(isStaffRole('parent')).toBe(false);
  });

  it('keeps finance CEO-only and opens the scoped signup-decision route to admin roles', () => {
    expect(rolesForCapability('finance.access')).toEqual(['super_admin']);
    expect(rolesForCapability('executive.manage')).toEqual(['super_admin']);
    expect(roleHasCapability('super_admin', 'finance.access')).toBe(true);
    expect(roleHasCapability('super_admin', 'signup.decide')).toBe(true);
    expect(roleHasCapability('admin', 'finance.access')).toBe(false);
    expect(roleHasCapability('admin', 'signup.decide')).toBe(true);
    expect(roleHasCapability('manager', 'signup.decide')).toBe(true);
    expect(claimsHaveCapability(['instructor', 'manager'], 'calendar.manage')).toBe(true);
    expect(claimsHaveCapability(['instructor'], 'calendar.manage')).toBe(false);
  });

  it('enforces the signup decision target matrix without role mutation', () => {
    expect(canDecideSignupRole('manager', 'instructor')).toBe(true);
    expect(canDecideSignupRole('manager', 'manager')).toBe(false);
    expect(canDecideSignupRole('admin', 'instructor')).toBe(true);
    expect(canDecideSignupRole('admin', 'manager')).toBe(true);
    expect(canDecideSignupRole('admin', 'admin')).toBe(false);
    expect(canDecideSignupRole('super_admin', 'admin')).toBe(true);
    expect(canDecideSignupRole('super_admin', 'super_admin')).toBe(false);
  });

  it('allows all admin roles to manage approvals and calendars', () => {
    for (const role of ['super_admin', 'admin', 'manager']) {
      expect(roleHasCapability(role, 'approval.manage')).toBe(true);
      expect(roleHasCapability(role, 'calendar.manage')).toBe(true);
      expect(roleHasCapability(role, 'counsel.manage')).toBe(true);
      expect(roleHasCapability(role, 'payout.readiness')).toBe(true);
    }
    expect(roleHasCapability('instructor', 'calendar.manage')).toBe(false);
    expect(roleHasCapability('instructor', 'counsel.manage')).toBe(false);
  });

  it('detects instructor-only claims without granting mixed admin claims', () => {
    expect(isInstructorOnly(['instructor'])).toBe(true);
    expect(isInstructorOnly(['instructor', 'manager'])).toBe(false);
  });
});
