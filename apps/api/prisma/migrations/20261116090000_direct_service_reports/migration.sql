-- Direct service reports (Requirement 4): a third report kind, "direct", for a visit recorded against a Customer / Site / RECD unit (DG)
-- WITHOUT a service ticket or an AMC order.
--
-- ADDITIVE and safe for existing data:
--   * no table, column or foreign key is added, changed or dropped; no row is touched;
--   * the "exactly one owner, matching kind" CHECK is replaced by a superset: every row that satisfied the old one still satisfies the new one
--     (the ticket and AMC shapes are copied unchanged, a third shape is added);
--   * one new PARTIAL unique index protects direct reports only; the ticket and AMC indexes are untouched;
--   * the final-report immutability triggers, status vocabulary, final-state rules and RESTRICT foreign keys are untouched. A direct report always
--     needs the customer's signature (acknowledgementRequired = true), exactly like a ticket report.
--
-- Direct report shape: no ticket, no AMC order, and the Site and the RECD unit (and, as for every report, the Customer) are all required.
-- The serial snapshot ("unitSerialNo") stays OPTIONAL: a unit without a serial is reported as "Not recorded".
--
-- Rollback (only while no direct report exists): DROP INDEX "ServiceReport_one_open_per_direct_unit"; ALTER TABLE "ServiceReport" DROP CONSTRAINT
--   "ServiceReport_kind_owner_check"; then re-add the previous two-shape CHECK from migration 20261018090000_amc_service_reports.

ALTER TABLE "ServiceReport" DROP CONSTRAINT "ServiceReport_kind_owner_check";
ALTER TABLE "ServiceReport" ADD CONSTRAINT "ServiceReport_kind_owner_check" CHECK (
  ("kind" = 'ticket' AND "complaintId" IS NOT NULL AND "amcOrderId" IS NULL AND "acknowledgementRequired" = true)
  OR ("kind" = 'amc' AND "amcOrderId" IS NOT NULL AND "complaintId" IS NULL AND "unitSerialNo" IS NOT NULL)
  OR ("kind" = 'direct' AND "complaintId" IS NULL AND "amcOrderId" IS NULL AND "siteId" IS NOT NULL AND "unitId" IS NOT NULL AND "acknowledgementRequired" = true)
);

-- One report IN PROGRESS per RECD unit for direct reports. Finished (signed) reports never block the next visit.
CREATE UNIQUE INDEX "ServiceReport_one_open_per_direct_unit" ON "ServiceReport"("unitId")
  WHERE "kind" = 'direct' AND "status" IN ('draft', 'awaiting_signature');
