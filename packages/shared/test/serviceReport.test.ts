import test from "node:test";
import assert from "node:assert/strict";
import {
  createDirectServiceReportSchema,
  SERVICE_REPORT_LIMITS,
  SERVICE_REPORT_STATUS,
  SIGNATURE_DATA_URL_PREFIX,
  SERVICE_REPORT_FINAL_STATUSES,
  SERVICE_REPORT_KIND,
  SERVICE_REPORT_OPEN_STATUSES,
  canTransitionServiceReport,
  createAmcServiceReportSchema,
  createServiceReportSchema,
  serviceReportMissingFields,
  signServiceReportSchema,
  updateServiceReportSchema,
} from "../src/index";

const base = { complaintId: "t1", visitDate: "2026-10-14" };

test("state machine: draft -> awaiting_signature -> signed, reopen allowed only before signing, signed is final", () => {
  const S = SERVICE_REPORT_STATUS;
  assert.equal(canTransitionServiceReport(S.DRAFT, S.AWAITING_SIGNATURE), true);
  assert.equal(canTransitionServiceReport(S.AWAITING_SIGNATURE, S.SIGNED), true);
  assert.equal(canTransitionServiceReport(S.AWAITING_SIGNATURE, S.DRAFT), true);
  assert.equal(canTransitionServiceReport(S.DRAFT, S.SIGNED), false, "an unsubmitted report can never jump to signed");
  for (const to of Object.values(S)) assert.equal(canTransitionServiceReport(S.SIGNED, to), false, `signed -> ${to}`);
  assert.equal(canTransitionServiceReport("nonsense", S.SIGNED), false);
  assert.equal(canTransitionServiceReport(S.DRAFT, "nonsense"), false);
});

test("create: only the visit date is required for a draft; ticket id is required; ownership ids are not part of the schema", () => {
  const ok = createServiceReportSchema.parse({ ...base, customerId: "cB", siteId: "sB", unitId: "uB", status: "signed" });
  assert.deepEqual(Object.keys(ok).sort(), ["complaintId", "findings", "resolution", "visitDate", "workPerformed"]);
  assert.equal(createServiceReportSchema.safeParse({ visitDate: "2026-10-14" }).success, false);
  assert.equal(createServiceReportSchema.safeParse({ complaintId: "t1" }).success, false);
});

test("visit date: real calendar dates in YYYY-MM-DD only, not in the future", () => {
  for (const bad of ["2026-02-30", "2026-13-01", "14/10/2026", "2026-10-14T00:00:00Z", "", "2999-01-01"]) {
    assert.equal(createServiceReportSchema.safeParse({ ...base, visitDate: bad }).success, false, bad);
  }
  assert.equal(createServiceReportSchema.safeParse({ ...base, visitDate: new Date().toISOString().slice(0, 10) }).success, true, "today is fine");
});

test("text fields are trimmed and capped", () => {
  assert.equal(createServiceReportSchema.parse({ ...base, workPerformed: "  done  " }).workPerformed, "done");
  assert.equal(createServiceReportSchema.safeParse({ ...base, findings: "x".repeat(SERVICE_REPORT_LIMITS.TEXT_MAX + 1) }).success, false);
});

test("update: needs the version the editor loaded", () => {
  assert.equal(updateServiceReportSchema.safeParse({ findings: "x" }).success, false);
  assert.equal(updateServiceReportSchema.safeParse({ findings: "x", expectedVersion: 0 }).success, false);
  assert.equal(updateServiceReportSchema.safeParse({ findings: "x", expectedVersion: 2 }).success, true);
});

test("submit check lists exactly the sections still missing", () => {
  assert.deepEqual(serviceReportMissingFields({ visitDate: "2026-10-14", workPerformed: "", findings: "", resolution: "" }), ["Work performed", "Findings", "Resolution"]);
  assert.deepEqual(serviceReportMissingFields({ visitDate: "2026-10-14", workPerformed: "ab", findings: "found a leak", resolution: "sealed it" }), ["Work performed"], "too short counts as missing");
  assert.deepEqual(serviceReportMissingFields({ visitDate: "2026-10-14", workPerformed: "did work", findings: "found a leak", resolution: "sealed it" }), []);
  assert.deepEqual(serviceReportMissingFields({ workPerformed: "did work", findings: "found a leak", resolution: "sealed it" }), ["Visit date"]);
});

test("sign payload: name, PNG data URL, version and an explicit confirmation are all required", () => {
  const good = { signerName: "Asha Rao", signatureImage: `${SIGNATURE_DATA_URL_PREFIX}AAAA`, version: 1, confirm: true };
  assert.equal(signServiceReportSchema.safeParse(good).success, true);
  assert.equal(signServiceReportSchema.parse({ ...good, signerName: "  Asha Rao " }).signerName, "Asha Rao");
  const bad: Array<Record<string, unknown>> = [
    { signerName: undefined }, { signerName: "A" }, { signerName: "N".repeat(SERVICE_REPORT_LIMITS.SIGNER_NAME_MAX + 1) },
    { signatureImage: undefined }, { signatureImage: "Asha Rao" }, { signatureImage: "data:image/jpeg;base64,AAAA" },
    { signatureImage: SIGNATURE_DATA_URL_PREFIX + "A".repeat(Math.ceil(SERVICE_REPORT_LIMITS.SIGNATURE_MAX_BYTES * 1.4)) },
    { version: undefined }, { version: 0 }, { version: 1.5 }, { confirm: false }, { confirm: undefined }, { confirm: "true" },
  ];
  for (const over of bad) assert.equal(signServiceReportSchema.safeParse({ ...good, ...over }).success, false, JSON.stringify(over).slice(0, 80));
});

test("'submitted' (older unsigned AMC reports) is final and can no longer be reached: every report must be signed", () => {
  const S = SERVICE_REPORT_STATUS;
  assert.equal(canTransitionServiceReport(S.DRAFT, S.SUBMITTED), false, "the unsigned finalisation path is withdrawn");
  assert.equal(canTransitionServiceReport(S.DRAFT, S.AWAITING_SIGNATURE), true);
  assert.equal(canTransitionServiceReport(S.AWAITING_SIGNATURE, S.SIGNED), true);
  assert.equal(canTransitionServiceReport(S.AWAITING_SIGNATURE, S.SUBMITTED), false, "a report waiting for the customer cannot be finalised without them");
  for (const to of Object.values(S)) assert.equal(canTransitionServiceReport(S.SUBMITTED, to), false, `submitted -> ${to}`);
  assert.deepEqual([...SERVICE_REPORT_FINAL_STATUSES].sort(), ["signed", "submitted"]);
  assert.deepEqual([...SERVICE_REPORT_OPEN_STATUSES].sort(), ["awaiting_signature", "draft"]);
  assert.deepEqual(Object.values(SERVICE_REPORT_KIND).sort(), ["amc", "direct", "ticket"]);
});

test("AMC report: the AMC order and the unit are the only ids the client chooses; there is no acknowledgement option", () => {
  const ok = createAmcServiceReportSchema.parse({ amcOrderId: "a1", unitId: "u1", visitDate: "2026-10-14", customerId: "cB", siteId: "sB", serialNo: "FAKE", unitSerialNo: "FAKE", status: "signed" });
  assert.deepEqual(Object.keys(ok).sort(), ["amcOrderId", "findings", "resolution", "unitId", "visitDate", "workPerformed"]);
  assert.equal("acknowledgementRequired" in createAmcServiceReportSchema.parse({ amcOrderId: "a1", unitId: "u1", visitDate: "2026-10-14", acknowledgementRequired: false }), false, "the flag is not accepted; the API refuses an explicit false");
  for (const bad of [{ unitId: "u1" }, { amcOrderId: "a1" }, { amcOrderId: "", unitId: "u1" }, { amcOrderId: "a1", unitId: "u1", visitDate: "2999-01-01" }]) {
    assert.equal(createAmcServiceReportSchema.safeParse({ visitDate: "2026-10-14", ...bad }).success, false, JSON.stringify(bad));
  }
  assert.equal("acknowledgementRequired" in (updateServiceReportSchema.parse({ expectedVersion: 1, acknowledgementRequired: false }) as object), false);
});

test("direct report: the RECD unit is the only id the client chooses (the customer may be sent only as a cross-check); everything else is derived by the API", () => {
  const ok = createDirectServiceReportSchema.parse({ unitId: "u1", customerId: "c1", visitDate: "2026-10-14", siteId: "FAKE", unitSerialNo: "FAKE", kind: "ticket", status: "signed", complaintId: "t1", amcOrderId: "a1", acknowledgementRequired: false });
  assert.deepEqual(Object.keys(ok).sort(), ["customerId", "findings", "resolution", "unitId", "visitDate", "workPerformed"], "no site, serial, kind, status, ticket, AMC or acknowledgement field survives parsing");
  assert.equal(createDirectServiceReportSchema.safeParse({ unitId: "u1", visitDate: "2026-10-14" }).success, true, "only the visit date and the unit are needed for a draft");
  for (const bad of [{ visitDate: "2026-10-14" }, { unitId: "", visitDate: "2026-10-14" }, { unitId: "u1" }, { unitId: "u1", visitDate: "14/10/2026" }, { unitId: "u1", visitDate: "2999-01-01" }, { unitId: "u1", visitDate: "2026-10-14", customerId: "" }]) {
    assert.equal(createDirectServiceReportSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test("direct report: a third report kind that shares the same states, the same mandatory signature path and the same missing-field rule", () => {
  assert.equal(SERVICE_REPORT_KIND.DIRECT, "direct");
  const S = SERVICE_REPORT_STATUS;
  assert.equal(canTransitionServiceReport(S.DRAFT, S.AWAITING_SIGNATURE), true);
  assert.equal(canTransitionServiceReport(S.AWAITING_SIGNATURE, S.SIGNED), true);
  assert.equal(canTransitionServiceReport(S.DRAFT, S.SIGNED), false, "never signed straight from a draft");
  assert.equal(canTransitionServiceReport(S.DRAFT, S.SUBMITTED), false, "never final without the customer");
  assert.equal(canTransitionServiceReport(S.SIGNED, S.DRAFT), false, "a signed report is permanent");
  assert.deepEqual(serviceReportMissingFields({ visitDate: "2026-10-14", workPerformed: "ok", findings: "", resolution: "x" }), ["Work performed", "Findings", "Resolution"]);
});
