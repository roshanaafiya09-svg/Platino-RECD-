/**
 * TEST-ONLY override for the real-database test guard (test/db/*.db.test.ts).
 *
 * By default those tests refuse to run unless DATABASE_URL and DIRECT_URL both point at the disposable Docker database `localhost:5434/platino_test`
 * (the check that every file keeps in its own `pointsAtIsolatedDb`; it is NOT changed). This helper adds ONE narrow, explicit alternative so the tests that
 * overwrite shared rows or toggle triggers can be run against a SEPARATE throw-away database instead of the shared one:
 *
 *   PLATINO_TEST_DB_OVERRIDE=<host>:<port>/<database>      e.g.  127.0.0.1:5435/platino_scratch_run1
 *
 * The override is accepted only when ALL of these hold - anything else is ignored and the default guard applies unchanged:
 *   - host is exactly `localhost` or `127.0.0.1` (never a remote or cloud host);
 *   - port is 4 or 5 digits and is NOT 5432 (the usual production / staging port) and NOT 5434 (the shared test database);
 *   - the database name starts with `platino_scratch_` (so it can never be `postgres`, `platino_test` or a production database name).
 * The connection URLs (DATABASE_URL and DIRECT_URL, BOTH) must then match that exact host, port and database name.
 *
 * It is read only by the test files; nothing in src/ imports it.
 */
export const TEST_DB_OVERRIDE_VAR = "PLATINO_TEST_DB_OVERRIDE";

const SHAPE = /^(localhost|127\.0\.0\.1):([0-9]{4,5})\/(platino_scratch_[a-z0-9_]{1,40})$/;
const FORBIDDEN_PORTS = new Set(["5432", "5434"]);

export interface TestDbTarget {
  host: string;
  port: string;
  database: string;
}

/** The validated override, or null when it is unset or does not satisfy every rule above. */
export function testOverrideTarget(env: Record<string, string | undefined> = process.env): TestDbTarget | null {
  const raw = env[TEST_DB_OVERRIDE_VAR];
  if (!raw) return null;
  const m = SHAPE.exec(raw.trim());
  if (!m) return null;
  const [, host, port, database] = m;
  if (FORBIDDEN_PORTS.has(port) || Number(port) > 65535) return null;
  return { host, port, database };
}

/** True only when `raw` is a connection URL for exactly the validated override target. */
export function allowedByTestOverride(raw: string | undefined, env: Record<string, string | undefined> = process.env): boolean {
  const target = testOverrideTarget(env);
  if (!target || !raw) return false;
  try {
    const u = new URL(raw);
    return u.hostname === target.host && u.port === target.port && u.pathname === `/${target.database}`;
  } catch {
    return false;
  }
}

/**
 * The database NAME the real-database tests expect `select current_database()` to return: `defaultName` (platino_test) unless a valid override is set,
 * in which case exactly the override's database name. This is the second, in-hook safety check of each test file - it verifies what the server itself says
 * it is connected to, not just what the connection URL claims.
 */
export function expectedTestDatabase(defaultName: string, env: Record<string, string | undefined> = process.env): string {
  return testOverrideTarget(env)?.database ?? defaultName;
}
