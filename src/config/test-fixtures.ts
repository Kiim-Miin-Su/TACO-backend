/**
 * Test-only business fixture boundary.
 *
 * Production and development always start from persisted data (or an empty
 * database). E2E tests may opt out to verify the fresh-database contract.
 */
export function testBusinessFixturesEnabled(): boolean {
  return process.env.NODE_ENV === 'test' && process.env.TEST_BUSINESS_FIXTURES !== '0';
}
