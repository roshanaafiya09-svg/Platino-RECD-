// The test-only database override (test/helpers/isolatedDb.ts): it must accept exactly one narrow kind of target and reject everything else, so
// it can never point the real-database tests at production, staging, the usual Postgres port or the shared test database. No database is contacted.
import test from "node:test";
import assert from "node:assert/strict";
import { TEST_DB_OVERRIDE_VAR, allowedByTestOverride, expectedTestDatabase, testOverrideTarget } from "./helpers/isolatedDb";

const env = (value?: string) => ({ [TEST_DB_OVERRIDE_VAR]: value });
const url = (hostPortDb: string) => `postgresql://u:p@${hostPortDb}`;

test("without the variable nothing is allowed (the default guard in each test file applies unchanged)", () => {
  assert.equal(testOverrideTarget(env(undefined)), null);
  assert.equal(allowedByTestOverride(url("127.0.0.1:5435/platino_scratch_run1"), env(undefined)), false);
  assert.equal(allowedByTestOverride(url("localhost:5434/platino_test"), env(undefined)), false, "the override never speaks for the default target");
});

test("a loopback host, a non-standard port and a platino_scratch_ database name are accepted - and only that exact URL matches", () => {
  const e = env("127.0.0.1:5435/platino_scratch_run1");
  assert.deepEqual(testOverrideTarget(e), { host: "127.0.0.1", port: "5435", database: "platino_scratch_run1" });
  assert.equal(allowedByTestOverride(url("127.0.0.1:5435/platino_scratch_run1"), e), true);
  assert.equal(allowedByTestOverride(url("127.0.0.1:5435/platino_scratch_run1?schema=public"), e), true, "query parameters do not change the target");
  assert.equal(allowedByTestOverride(url("127.0.0.1:5436/platino_scratch_run1"), e), false, "another port");
  assert.equal(allowedByTestOverride(url("127.0.0.1:5435/platino_scratch_other"), e), false, "another database");
  assert.equal(allowedByTestOverride(url("localhost:5435/platino_scratch_run1"), e), false, "another host spelling than the one declared");
  assert.equal(allowedByTestOverride(url("db.example.com:5435/platino_scratch_run1"), e), false, "a remote host");
  assert.equal(allowedByTestOverride(undefined, e), false);
  assert.equal(allowedByTestOverride("not a url", e), false);
});

test("production-like, staging-like and shared targets are rejected as override values", () => {
  for (const bad of [
    "127.0.0.1:5432/platino_scratch_run1", // the usual Postgres / production port
    "127.0.0.1:5434/platino_scratch_run1", // the shared test database's port
    "localhost:5434/platino_test", // the shared test database itself
    "127.0.0.1:5435/platino_test", // not a scratch name
    "127.0.0.1:5435/postgres", // the default database name
    "127.0.0.1:5435/platino_scratch", // missing the suffix after the prefix
    "127.0.0.1:5435/platino_scratch_RUN1", // upper case
    "127.0.0.1:99999/platino_scratch_run1", // not a port
    "aws-0-ap-south-1.pooler.supabase.com:6543/platino_scratch_run1", // a cloud pooler
    "db.example.supabase.co:5435/platino_scratch_run1", // a remote host
    "10.0.0.5:5435/platino_scratch_run1", // a private-network address
    "0.0.0.0:5435/platino_scratch_run1",
    "[::1]:5435/platino_scratch_run1",
    "127.0.0.1:5435/platino_scratch_run1/extra",
    "postgresql://u:p@127.0.0.1:5435/platino_scratch_run1", // a full URL is not the expected form
    "",
    "   ",
  ]) {
    assert.equal(testOverrideTarget(env(bad)), null, `must be rejected: ${bad}`);
    assert.equal(allowedByTestOverride(url("127.0.0.1:5435/platino_scratch_run1"), env(bad)), false, `must not allow anything: ${bad}`);
  }
});

test("both connection URLs must match: a production URL next to a valid override is still refused", () => {
  const e = env("127.0.0.1:5435/platino_scratch_run1");
  assert.equal(allowedByTestOverride(url("aws-0-ap-south-1.pooler.supabase.com:6543/postgres"), e), false);
  assert.equal(allowedByTestOverride(url("127.0.0.1:5432/postgres"), e), false);
});

test("the in-hook database-name check expects the default name, or exactly the validated override's name", () => {
  assert.equal(expectedTestDatabase("platino_test", env(undefined)), "platino_test");
  assert.equal(expectedTestDatabase("platino_test", env("127.0.0.1:5435/platino_scratch_run1")), "platino_scratch_run1");
  for (const bad of ["127.0.0.1:5432/platino_scratch_run1", "127.0.0.1:5435/postgres", "db.example.com:5435/platino_scratch_run1", ""]) {
    assert.equal(expectedTestDatabase("platino_test", env(bad)), "platino_test", `an invalid override never changes the expectation: ${bad}`);
  }
});
