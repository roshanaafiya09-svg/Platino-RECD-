// Zod 4 changed how .partial() treats fields that have a .default(): the default is now applied when the key is absent. An update (PATCH) schema
// must NEVER fill in values the caller did not send, or a one-field edit would blank everything else. These tests pin that for every update schema.
import test from "node:test";
import assert from "node:assert/strict";
import { updateServiceReportSchema, updateSiteContactSchema, updateProductSchema } from "../src";

test("updateServiceReportSchema: a PATCH that sends one field does not blank the others (absent stays absent)", () => {
  const parsed = updateServiceReportSchema.parse({ expectedVersion: 2, resolution: "Replaced the filter" });
  assert.deepEqual(parsed, { expectedVersion: 2, resolution: "Replaced the filter" });
  assert.equal("workPerformed" in parsed, false);
  assert.equal("findings" in parsed, false);
  assert.equal("acknowledgementRequired" in parsed, false);
});

test("updateServiceReportSchema: an explicit empty string is still accepted and kept (the caller chose it)", () => {
  assert.deepEqual(updateServiceReportSchema.parse({ expectedVersion: 1, findings: "" }), { expectedVersion: 1, findings: "" });
});

test("updateServiceReportSchema: the version is still required and the visit date is still checked", () => {
  assert.equal(updateServiceReportSchema.safeParse({ resolution: "x" }).success, false, "expectedVersion is required");
  assert.equal(updateServiceReportSchema.safeParse({ expectedVersion: 1, visitDate: "2999-01-01" }).success, false, "future date refused");
  assert.equal(updateServiceReportSchema.safeParse({ expectedVersion: 1, visitDate: "not a date" }).success, false);
});

test("other update schemas built with .partial() never invent keys that were not sent", () => {
  for (const schema of [updateSiteContactSchema, updateProductSchema]) {
    const parsed = schema.safeParse({});
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.success ? parsed.data : null, {}, "an empty update stays empty");
  }
});
