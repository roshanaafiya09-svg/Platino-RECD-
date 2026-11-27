import { Router, type Response } from "express";
import { Prisma } from "@prisma/client";
import {
  AMC_TYPE_LABELS,
  COMPLAINT_EVENT,
  PERMISSION_KEY,
  ROLE_KEY,
  SERVICE_REPORT_FINAL_STATUSES,
  SERVICE_REPORT_KIND,
  SERVICE_REPORT_OPEN_STATUSES,
  SERVICE_REPORT_STATUS,
  TICKET_FINISHED_STATUSES,
  canTransitionServiceReport,
  createAmcServiceReportSchema,
  createDirectServiceReportSchema,
  createServiceReportSchema,
  reopenServiceReportSchema,
  serviceReportMissingFields,
  signServiceReportSchema,
  startSigningSessionSchema,
  submitServiceReportSchema,
  updateServiceReportSchema,
} from "@recd/shared";
import { prisma } from "../lib/prisma";
import { authenticate, authLookup, type AuthenticatedRequest } from "../middleware/auth";
import { SIGNING_CANCELLED_EVENT, SIGNING_INVALID_ERROR, SIGNING_STARTED_EVENT, signingCredentialGate, type SigningRequest } from "../middleware/signingCredential";
import { asString, asOptionalString } from "../lib/params";
import { managedRegionIds } from "../lib/regions";
import { logComplaintEvent } from "../lib/ticketEvents";
import { checkSignatureDataUrl } from "../lib/signatureImage";
import { buildServiceReportPdf, type ServiceReportPdfInput } from "../lib/serviceReportPdf";
import { getReportStorage, sha256Hex, type ReportStorage } from "../lib/reportStorage";
import { checkSigningSession, issueSigningCredential, issueSigningSession, newSigningSessionId } from "../lib/signingSession";

/**
 * Digital service reports. Three kinds share ONE table, one state machine, one signature check, one PDF builder and one
 * file store:
 *   - "ticket" (Requirement 4): a visit on a service ticket.
 *   - "amc"    (Requirement 5): a visit under an AMC order, for ONE RECD unit that the order covers.
 *   - "direct" (Requirement 4): a visit recorded straight from the Service Reports page against a RECD unit (DG), with no ticket or AMC order.
 *     The Customer, the Site and the serial snapshot are DERIVED from the chosen unit; nothing but the unit (and an optional customer cross-check)
 *     comes from the request.
 *
 * States: draft -> awaiting_signature -> signed (final). EVERY report needs the customer's signature: the older "acknowledgement
 * not required" AMC path (draft -> submitted, unsigned) can no longer be started. A "submitted" report that already exists keeps
 * being viewable and downloadable, exactly as stored. Final reports are immutable (API and database trigger).
 *
 * WHO MAY DO WHAT (all enforced here, never by the screens):
 *  TICKET reports - write: MANAGE_COMPLAINTS, or ACT_ASSIGNED_COMPLAINTS on a ticket assigned to that user (vendor users
 *    only for their vendor's sites, Regional Managers only for their regions). Read: those staff plus
 *    VIEW_COMPLAINTS_OVERVIEW holders.
 *  AMC reports - write AND read for: MANAGE_AMC_ORDERS (management), MANAGE_COMPLAINTS (service team, service managers,
 *    regional managers) and - only for a unit on which a ticket is ASSIGNED to them - ACT_ASSIGNED_COMPLAINTS (field engineers).
 *    Vendor-scoped users and Regional Managers are additionally limited to their sites/regions. Sales, finance and everyone
 *    holding none of those permissions get nothing.
 *  DIRECT reports - write: MANAGE_COMPLAINTS holders (management, service team, service managers, regional managers) for units at sites in their
 *    vendor / region scope. Read: those, VIEW_COMPLAINTS_OVERVIEW holders, and a field engineer for a unit on which a ticket is assigned to them
 *    (read only: engineers create reports through their assigned tickets, because a direct report has no assignment to set their scope).
 *  SIGNING is IN PERSON, on the staff device: after submitting, staff hand the device to the customer, who reviews the report, types their own name,
 *    draws their own signature and approves. A customer LOGIN can no longer sign (and there is no customer list of reports any more); the signature
 *    is accepted only from the staff session that handed the device over (POST /:id/signing-session), within a short window, for the report version
 *    shown. The signer is recorded by the NAME THE CUSTOMER TYPED (signedById stays empty: no account is invented and the staff account is not
 *    the signer); the staff account is recorded as the one that captured it, in the audit trail and on the PDF.
 *  Customers (all kinds) - may still READ the reports of their OWN customer once they have left draft (API only; no screen offers it any more).
 *  customerId / siteId / unitId / serial are never read from a request body: tickets give them for ticket reports; the AMC
 *  order and the covered unit give them for AMC reports.
 */
export const serviceReportsRouter = Router();
// A request with `Authorization: Signing <credential>` is handled by the gate (three approved requests only, see middleware/signingCredential.ts).
// Every other request - and every request of a signing credential that the gate did not take - needs a normal Bearer login, exactly as before.
serviceReportsRouter.use(signingCredentialGate);
serviceReportsRouter.use((req, res, next) => ((req as SigningRequest).signing ? next() : authenticate(req, res, next)));

const MAX_NUMBER_ATTEMPTS = 3;
const NOT_FOUND = { error: "Service report not found" };
const EVENT_UPDATED = "service_report_updated";
const EVENT_SIGNING_STARTED = SIGNING_STARTED_EVENT;
const EVENT_SIGNING_CANCELLED = SIGNING_CANCELLED_EVENT;
const amcRef = (amcOrderId: string) => `AMC-${amcOrderId.slice(-6).toUpperCase()}`;

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

interface Access {
  read: boolean;
  write: boolean;
}
const NONE: Access = { read: false, write: false };

interface TicketScope {
  assignedToId: string | null;
  site: { regionId: string | null; vendorId: string | null } | null;
}

/** What staff may do with a ticket's reports. Customers are never staff. */
async function staffAccess(req: AuthenticatedRequest, ticket: TicketScope): Promise<Access> {
  const a = req.auth!;
  if (a.customerId) return NONE;
  const manage = a.permissions.has(PERMISSION_KEY.MANAGE_COMPLAINTS);
  const act = a.permissions.has(PERMISSION_KEY.ACT_ASSIGNED_COMPLAINTS) && ticket.assignedToId === a.userId;
  const overview = a.permissions.has(PERMISSION_KEY.VIEW_COMPLAINTS_OVERVIEW);
  if (!manage && !act && !overview) return NONE;
  if (a.vendorId && ticket.site?.vendorId !== a.vendorId) return NONE;
  if (a.roleKey === ROLE_KEY.REGIONAL_MANAGER) {
    const regions = await managedRegionIds(a.userId, a.roleKey);
    if (!ticket.site?.regionId || !regions.includes(ticket.site.regionId)) return NONE;
  }
  return { read: true, write: manage || act };
}

/**
 * What staff may do with AMC reports. Who: MANAGE_AMC_ORDERS or MANAGE_COMPLAINTS holders; a field engineer (ACT_ASSIGNED_COMPLAINTS only)
 * just for a unit on which a ticket is assigned to them (`unitId`). Narrowed by the unit's site for vendor and regional users. `site` is null
 * when no particular site is in play (a list for a whole AMC order, `scoped` = false): scoped users then get nothing, which is the
 * conservative reading.
 */
async function amcStaffAccess(req: AuthenticatedRequest, site: { regionId: string | null; vendorId: string | null } | null | undefined, scoped = true, unitId?: string | null): Promise<Access> {
  const a = req.auth!;
  if (a.customerId) return NONE;
  const amc = a.permissions.has(PERMISSION_KEY.MANAGE_AMC_ORDERS);
  const manage = a.permissions.has(PERMISSION_KEY.MANAGE_COMPLAINTS);
  const act = a.permissions.has(PERMISSION_KEY.ACT_ASSIGNED_COMPLAINTS);
  if (!amc && !manage && !act) return NONE;
  if (a.vendorId && (!scoped || site?.vendorId !== a.vendorId)) return NONE;
  if (a.roleKey === ROLE_KEY.REGIONAL_MANAGER) {
    const regions = await managedRegionIds(a.userId, a.roleKey);
    if (!scoped || !site?.regionId || !regions.includes(site.regionId)) return NONE;
  }
  if (amc || manage) return { read: true, write: true };
  // A field engineer: only for a unit they have a ticket assigned on.
  if (!unitId) return NONE;
  const assigned = await prisma.complaint.findFirst({ where: { assignedToId: a.userId, unitId }, select: { id: true } });
  return assigned ? { read: true, write: true } : NONE;
}

/**
 * What staff may do with DIRECT reports. Write: MANAGE_COMPLAINTS. Read: that, VIEW_COMPLAINTS_OVERVIEW, or - for a field engineer - a ticket assigned
 * to them on this unit. Vendor users only see their vendor's sites and Regional Managers only their regions, as for every other report.
 */
async function directStaffAccess(req: AuthenticatedRequest, site: { regionId: string | null; vendorId: string | null } | null | undefined, unitId: string | null | undefined): Promise<Access> {
  const a = req.auth!;
  if (a.customerId) return NONE;
  const manage = a.permissions.has(PERMISSION_KEY.MANAGE_COMPLAINTS);
  const overview = a.permissions.has(PERMISSION_KEY.VIEW_COMPLAINTS_OVERVIEW);
  const act = a.permissions.has(PERMISSION_KEY.ACT_ASSIGNED_COMPLAINTS);
  if (!manage && !overview && !act) return NONE;
  if (a.vendorId && site?.vendorId !== a.vendorId) return NONE;
  if (a.roleKey === ROLE_KEY.REGIONAL_MANAGER) {
    const regions = await managedRegionIds(a.userId, a.roleKey);
    if (!site?.regionId || !regions.includes(site.regionId)) return NONE;
  }
  if (manage) return { read: true, write: true };
  if (overview) return { read: true, write: false };
  if (!unitId) return NONE;
  const assigned = await prisma.complaint.findFirst({ where: { assignedToId: a.userId, unitId }, select: { id: true } });
  return assigned ? { read: true, write: false } : NONE;
}

const isOwnCustomer = (req: AuthenticatedRequest, customerId: string) => !!req.auth!.customerId && req.auth!.customerId === customerId;

const ticketSelect = {
  id: true,
  archivedAt: true,
  ticketNumber: true,
  status: true,
  customerId: true,
  siteId: true,
  unitId: true,
  assignedToId: true,
  site: { select: { id: true, regionId: true, vendorId: true } },
} as const;

const reportInclude = {
  complaint: { select: ticketSelect },
  amcOrder: { select: { id: true, poNo: true, poDate: true, amcType: true, amcFrequencyPerYear: true, location: true } },
  site: { select: { id: true, regionId: true, vendorId: true } },
  createdBy: { select: { id: true, name: true } },
} as const;

type ReportRow = Prisma.ServiceReportGetPayload<{ include: typeof reportInclude }>;

async function accessTo(req: AuthenticatedRequest, report: ReportRow): Promise<Access> {
  if (report.kind === SERVICE_REPORT_KIND.AMC) return amcStaffAccess(req, report.site, true, report.unitId);
  if (report.kind === SERVICE_REPORT_KIND.DIRECT) return directStaffAccess(req, report.site, report.unitId);
  return report.complaint ? staffAccess(req, report.complaint) : NONE;
}

/** Loads a report and decides what the caller may do with it. Unknown OR forbidden both look like "not found" to customers. */
async function loadWithAccess(req: AuthenticatedRequest, res: Response, id: string): Promise<{ report: ReportRow; staff: Access; customer: boolean } | null> {
  const report = await prisma.serviceReport.findUnique({ where: { id }, include: reportInclude });
  if (!report) {
    res.status(404).json(NOT_FOUND);
    return null;
  }
  const staff = await accessTo(req, report);
  const customer = isOwnCustomer(req, report.customerId) && report.status !== SERVICE_REPORT_STATUS.DRAFT;
  if (!staff.read && !customer) {
    if (req.auth!.customerId) res.status(404).json(NOT_FOUND);
    else res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return { report, staff, customer };
}

// ---------------------------------------------------------------------------
// Presentation + integrity
// ---------------------------------------------------------------------------

const dateOnly = (d: Date) => d.toISOString().slice(0, 10);
const isFinal = (status: string) => (SERVICE_REPORT_FINAL_STATUSES as string[]).includes(status);

function toApi(r: ReportRow) {
  return {
    id: r.id,
    reportNumber: r.reportNumber,
    kind: r.kind,
    complaintId: r.complaintId,
    ticketNumber: r.complaint?.ticketNumber ?? null,
    amc: r.amcOrder
      ? { id: r.amcOrder.id, ref: amcRef(r.amcOrder.id), poNo: r.amcOrder.poNo, type: r.amcOrder.amcType, typeLabel: AMC_TYPE_LABELS[r.amcOrder.amcType] ?? r.amcOrder.amcType }
      : null,
    customerId: r.customerId,
    siteId: r.siteId,
    unitId: r.unitId,
    unitSerialNo: r.unitSerialNo,
    acknowledgementRequired: r.acknowledgementRequired,
    status: r.status,
    version: r.version,
    visitDate: dateOnly(r.visitDate),
    workPerformed: r.workPerformed,
    findings: r.findings,
    resolution: r.resolution,
    partsUsed: r.partsUsed,
    remarks: r.remarks,
    engineer: r.createdBy,
    createdAt: r.createdAt,
    submittedAt: r.submittedAt,
    signedAt: r.signedAt,
    signerName: r.signerName,
    signedVersion: r.signedVersion,
    /** True when a final PDF exists (signed, or submitted without signature) - served only by GET /:id/pdf after authorisation. */
    pdfAvailable: isFinal(r.status) && !!r.pdfFileId,
  };
}

type Fingerprinted = Pick<ReportRow, "reportNumber" | "complaintId" | "customerId" | "siteId" | "unitId" | "visitDate" | "workPerformed" | "findings" | "resolution" | "partsUsed" | "remarks" | "version"> &
  Partial<Pick<ReportRow, "kind" | "amcOrderId" | "unitSerialNo" | "acknowledgementRequired">>;

/**
 * Fingerprint of everything the customer is asked to approve. The TICKET formula is exactly the Requirement 4 one (so
 * reports already awaiting signature when AMC support shipped still verify); AMC reports also bind the AMC order, the
 * serial snapshot and the acknowledgement rule.
 */
export function reportContentHash(r: Fingerprinted): string {
  const core = [r.reportNumber, r.complaintId, r.customerId, r.siteId, r.unitId, dateOnly(r.visitDate), r.workPerformed, r.findings, r.resolution, r.partsUsed ?? "", r.remarks ?? "", r.version];
  if (r.kind === SERVICE_REPORT_KIND.AMC) return sha256Hex(JSON.stringify([...core, "amc", r.amcOrderId, r.unitSerialNo, r.acknowledgementRequired]));
  // A DIRECT report also binds the serial snapshot (empty when the unit has none). The ticket and AMC formulas above are unchanged.
  if (r.kind === SERVICE_REPORT_KIND.DIRECT) return sha256Hex(JSON.stringify([...core, "direct", r.unitSerialNo ?? ""]));
  return sha256Hex(JSON.stringify(core));
}

/** Audit: every report keeps its own history; ticket reports also appear in the ticket history. */
async function event(req: AuthenticatedRequest, r: ReportRow, type: string, toValue: string, fromValue?: string | null, extra: Record<string, unknown> = {}) {
  const detail = { reportId: r.id, reportNumber: r.reportNumber, kind: r.kind, version: r.version, amcOrderId: r.amcOrderId, unitId: r.unitId, ...extra } as Prisma.InputJsonValue;
  try {
    await prisma.serviceReportEvent.create({ data: { reportId: r.id, type, fromValue: fromValue ?? null, toValue, actorId: req.auth!.userId, detail } });
  } catch (err) {
    console.error("Failed to log service report event", err instanceof Error ? err.name : "unknown");
  }
  if (r.complaintId && type !== EVENT_UPDATED && type !== EVENT_SIGNING_STARTED && type !== EVENT_SIGNING_CANCELLED) {
    await logComplaintEvent({ complaintId: r.complaintId, type: type as never, fromValue: fromValue ?? null, toValue, actorId: req.auth!.userId, detail });
  }
}

/** Like `event`, but a failure to write is NOT swallowed: used for the records that decide whether a signing credential is live (started / cancelled). */
async function signingSessionEvent(req: AuthenticatedRequest, r: ReportRow, type: string, extra: Record<string, unknown>) {
  const detail = { reportId: r.id, reportNumber: r.reportNumber, kind: r.kind, version: r.version, amcOrderId: r.amcOrderId, unitId: r.unitId, ...extra } as Prisma.InputJsonValue;
  await prisma.serviceReportEvent.create({
    data: { reportId: r.id, type, fromValue: SERVICE_REPORT_STATUS.AWAITING_SIGNATURE, toValue: SERVICE_REPORT_STATUS.AWAITING_SIGNATURE, actorId: req.auth!.userId, detail },
  });
}

const staleVersion = (res: Response) =>
  res.status(409).json({ error: "This report was changed by someone else. Reload it and try again.", code: "STALE_VERSION" });

// ---------------------------------------------------------------------------
// List / read
// ---------------------------------------------------------------------------

/**
 * Which reports a STAFF user may list, as a Prisma filter - the same rules as staffAccess / amcStaffAccess, expressed once for a whole list:
 *  - ticket reports: MANAGE_COMPLAINTS or VIEW_COMPLAINTS_OVERVIEW see every ticket's reports; ACT_ASSIGNED_COMPLAINTS only those of tickets
 *    assigned to them; a vendor user only their vendor's sites; a Regional Manager only their mapped regions (a ticket without a site is out of
 *    every region and out of every vendor).
 *  - AMC reports: MANAGE_AMC_ORDERS or MANAGE_COMPLAINTS, narrowed by the report's site for vendor and regional users in the same way; a field
 *    engineer only those of units on which a ticket is assigned to them.
 * Returns null when the user may list nothing. Customers never get here (they use /mine or a ticket / AMC order they own).
 */
async function staffListScope(req: AuthenticatedRequest): Promise<Prisma.ServiceReportWhereInput | null> {
  const a = req.auth!;
  if (a.customerId) return null;
  const regions = a.roleKey === ROLE_KEY.REGIONAL_MANAGER ? await managedRegionIds(a.userId, a.roleKey) : null;
  const siteScope = (): Prisma.SiteWhereInput => ({
    ...(a.vendorId ? { vendorId: a.vendorId } : {}),
    ...(regions ? { regionId: { in: regions } } : {}),
  });
  const scoped = !!a.vendorId || !!regions;

  const clauses: Prisma.ServiceReportWhereInput[] = [];
  const seesAllTickets = a.permissions.has(PERMISSION_KEY.MANAGE_COMPLAINTS) || a.permissions.has(PERMISSION_KEY.VIEW_COMPLAINTS_OVERVIEW);
  const seesAssigned = a.permissions.has(PERMISSION_KEY.ACT_ASSIGNED_COMPLAINTS);
  if (seesAllTickets || seesAssigned) {
    clauses.push({
      kind: SERVICE_REPORT_KIND.TICKET,
      complaint: {
        ...(seesAllTickets ? {} : { assignedToId: a.userId }),
        ...(scoped ? { site: siteScope() } : {}),
      },
    });
  }
  if (a.permissions.has(PERMISSION_KEY.MANAGE_AMC_ORDERS) || a.permissions.has(PERMISSION_KEY.MANAGE_COMPLAINTS)) {
    clauses.push({ kind: SERVICE_REPORT_KIND.AMC, ...(scoped ? { site: siteScope() } : {}) });
  } else if (seesAssigned) {
    // A field engineer: AMC reports only for units on which a ticket is assigned to them.
    clauses.push({ kind: SERVICE_REPORT_KIND.AMC, unit: { complaints: { some: { assignedToId: a.userId } } }, ...(scoped ? { site: siteScope() } : {}) });
  }
  // DIRECT reports: managers and overview holders see them (site-scoped); a field engineer only those of units with a ticket assigned to them.
  if (seesAllTickets) {
    clauses.push({ kind: SERVICE_REPORT_KIND.DIRECT, ...(scoped ? { site: siteScope() } : {}) });
  } else if (seesAssigned) {
    clauses.push({ kind: SERVICE_REPORT_KIND.DIRECT, unit: { complaints: { some: { assignedToId: a.userId } } }, ...(scoped ? { site: siteScope() } : {}) });
  }
  return clauses.length ? { OR: clauses } : null;
}

const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 100;

const listInclude = {
  ...reportInclude,
  customer: { select: { id: true, name: true } },
  site: { select: { id: true, regionId: true, vendorId: true, companyName: true } },
  unit: { select: { id: true, serialNo: true } },
} as const;

/**
 * Staff list of service reports across tickets and AMC orders, narrowed by the caller's own scope (staffListScope) AND the optional filters
 * status, kind, customerId, siteId, unitId and a free-text q (report number, ticket number, serial, customer, site). A filter can only ever
 * narrow what the caller may already see.
 */
async function listForStaff(req: AuthenticatedRequest, res: Response) {
  const scope = await staffListScope(req);
  if (!scope) return res.status(403).json({ error: "Forbidden" });

  const status = asOptionalString(req.query.status);
  const kind = asOptionalString(req.query.kind);
  if (status && !Object.values(SERVICE_REPORT_STATUS).includes(status as never)) return res.status(400).json({ error: "Unknown status" });
  if (kind && !Object.values(SERVICE_REPORT_KIND).includes(kind as never)) return res.status(400).json({ error: "Unknown kind" });
  const customerId = asOptionalString(req.query.customerId);
  const siteId = asOptionalString(req.query.siteId);
  const unitId = asOptionalString(req.query.unitId);
  const q = asOptionalString(req.query.q)?.trim().slice(0, 100);
  const limit = Math.min(Math.max(parseInt(asOptionalString(req.query.limit) ?? "", 10) || LIST_DEFAULT_LIMIT, 1), LIST_MAX_LIMIT);
  const offset = Math.max(parseInt(asOptionalString(req.query.offset) ?? "", 10) || 0, 0);

  const contains = (v: string) => ({ contains: v, mode: "insensitive" as const });
  const where: Prisma.ServiceReportWhereInput = {
    AND: [
      scope,
      ...(status ? [{ status }] : []),
      ...(kind ? [{ kind }] : []),
      ...(customerId ? [{ customerId }] : []),
      ...(siteId ? [{ siteId }] : []),
      ...(unitId ? [{ unitId }] : []),
      ...(q
        ? [
            {
              OR: [
                { reportNumber: contains(q) },
                { unitSerialNo: contains(q) },
                { unit: { serialNo: contains(q) } },
                { complaint: { ticketNumber: contains(q) } },
                { customer: { name: contains(q) } },
                { site: { companyName: contains(q) } },
              ],
            },
          ]
        : []),
    ],
  };

  const [total, rows] = await Promise.all([
    prisma.serviceReport.count({ where }),
    prisma.serviceReport.findMany({ where, include: listInclude, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: limit, skip: offset }),
  ]);
  res.json({
    total,
    limit,
    offset,
    reports: rows.map((r) => ({
      ...toApi(r as unknown as ReportRow),
      customerName: r.customer.name,
      siteName: r.site?.companyName ?? null,
      // An AMC report prints its own snapshot; a ticket report has none, so the unit's current serial is shown.
      unitSerial: r.unitSerialNo ?? r.unit?.serialNo ?? null,
    })),
  });
}

serviceReportsRouter.get("/", async (req: AuthenticatedRequest, res) => {
  const complaintId = asOptionalString(req.query.complaintId);
  const amcOrderId = asOptionalString(req.query.amcOrderId);
  if (complaintId && amcOrderId) return res.status(400).json({ error: "Ask for the reports of a ticket OR of an AMC order, not both" });
  if (!complaintId && !amcOrderId) {
    // No ticket / AMC order named: staff get their scoped list; a customer must name one of their own (or use /mine).
    if (req.auth!.customerId) return res.status(400).json({ error: "complaintId or amcOrderId is required" });
    return listForStaff(req, res);
  }

  if (amcOrderId) {
    const amc = await prisma.amcOrder.findUnique({
      where: { id: amcOrderId },
      select: {
        id: true, poNo: true, poDate: true, amcType: true, amcFrequencyPerYear: true, location: true, customerId: true,
        customer: { select: { name: true } },
        units: { select: { unit: { select: { id: true, serialNo: true, status: true, site: { select: { companyName: true, address: true, regionId: true, vendorId: true } } } } } },
      },
    });
    if (!amc) return res.status(req.auth!.customerId ? 404 : 404).json({ error: "AMC order not found" });
    let staff = await amcStaffAccess(req, null, false);
    const customer = isOwnCustomer(req, amc.customerId);
    // Service staff without an order-wide AMC right (field engineers, vendor / regional service users) see only the units they may handle.
    let allowedUnitIds: string[] | null = null;
    const perms = req.auth!.permissions;
    if (!staff.read && !customer && !req.auth!.customerId && !perms.has(PERMISSION_KEY.MANAGE_AMC_ORDERS) && (perms.has(PERMISSION_KEY.MANAGE_COMPLAINTS) || perms.has(PERMISSION_KEY.ACT_ASSIGNED_COMPLAINTS))) {
      allowedUnitIds = [];
      for (const l of amc.units) {
        if ((await amcStaffAccess(req, l.unit.site, true, l.unit.id)).read) allowedUnitIds.push(l.unit.id);
      }
      if (allowedUnitIds.length) staff = { read: true, write: true };
    }
    if (!staff.read && !customer) return res.status(req.auth!.customerId ? 404 : 403).json(req.auth!.customerId ? { error: "AMC order not found" } : { error: "Forbidden" });

    const unitFilter = asOptionalString(req.query.unitId);
    const reports = await prisma.serviceReport.findMany({
      where: { amcOrderId, ...(unitFilter ? { unitId: unitFilter } : {}), ...(allowedUnitIds ? { unitId: { in: allowedUnitIds } } : {}), ...(staff.read ? {} : { status: { not: SERVICE_REPORT_STATUS.DRAFT } }) },
      include: reportInclude,
      orderBy: { createdAt: "asc" },
    });
    return res.json({
      canWrite: staff.write,
      reports: reports.map(toApi),
      context: {
        kind: SERVICE_REPORT_KIND.AMC,
        amc: { id: amc.id, ref: amcRef(amc.id), poNo: amc.poNo, poDate: dateOnly(amc.poDate), type: amc.amcType, typeLabel: AMC_TYPE_LABELS[amc.amcType] ?? amc.amcType, location: amc.location, visitsPerYear: amc.amcFrequencyPerYear, customerName: amc.customer.name },
        units: amc.units.filter((l) => !allowedUnitIds || allowedUnitIds.includes(l.unit.id)).map((l) => ({ id: l.unit.id, serialNo: l.unit.serialNo, status: l.unit.status, siteName: l.unit.site?.companyName ?? null, address: l.unit.site?.address ?? null })),
      },
    });
  }

  const ticket = await prisma.complaint.findUnique({ where: { id: complaintId! }, select: ticketSelect });
  if (!ticket) return res.status(404).json({ error: "Complaint not found" });

  const staff = await staffAccess(req, ticket);
  const customer = isOwnCustomer(req, ticket.customerId);
  if (!staff.read && !customer) return res.status(customer || req.auth!.customerId ? 404 : 403).json(req.auth!.customerId ? { error: "Complaint not found" } : { error: "Forbidden" });

  const reports = await prisma.serviceReport.findMany({
    where: { complaintId: complaintId!, ...(staff.read ? {} : { status: { not: SERVICE_REPORT_STATUS.DRAFT } }) },
    include: reportInclude,
    orderBy: { createdAt: "asc" },
  });
  res.json({ canWrite: staff.write, reports: reports.map(toApi) });
});

/**
 * The choices behind "+ New Service Report": WITHOUT a query, the customers the caller may report on (those with an active RECD unit at a site in
 * their scope); WITH ?customerId=, that customer's active RECD units (DG) with their Site, so the form can show the derived Site read-only and warn
 * about an open ticket or an open direct report on the unit. Same boundary as creating a direct report (MANAGE_COMPLAINTS; vendor / region scope).
 */
serviceReportsRouter.get("/direct-options", async (req: AuthenticatedRequest, res) => {
  const a = req.auth!;
  if (a.customerId || !a.permissions.has(PERMISSION_KEY.MANAGE_COMPLAINTS)) return res.status(403).json({ error: "You cannot create a direct service report" });
  const regions = a.roleKey === ROLE_KEY.REGIONAL_MANAGER ? await managedRegionIds(a.userId, a.roleKey) : null;
  const siteScope: Prisma.SiteWhereInput = { ...(a.vendorId ? { vendorId: a.vendorId } : {}), ...(regions ? { regionId: { in: regions } } : {}) };
  const unitWhere: Prisma.RecdUnitWhereInput = { status: "active", siteId: { not: null }, ...(a.vendorId || regions ? { site: siteScope } : {}) };

  const customerId = asOptionalString(req.query.customerId);
  if (!customerId) {
    const customers = await prisma.customer.findMany({
      where: { orders: { some: { units: { some: unitWhere } } } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
      take: 500,
    });
    return res.json({ customers });
  }

  const units = await prisma.recdUnit.findMany({
    where: { ...unitWhere, order: { customerId } },
    select: {
      id: true, serialNo: true,
      product: { select: { name: true, model: true } },
      site: { select: { id: true, companyName: true, address: true, dgModel: true, dgCapacityKva: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: 300,
  });
  const unitIds = units.map((u) => u.id);
  const [tickets, openReports] = unitIds.length === 0
    ? [[], []]
    : await Promise.all([
        prisma.complaint.findMany({ where: { unitId: { in: unitIds }, archivedAt: null, status: { notIn: TICKET_FINISHED_STATUSES } }, select: { id: true, ticketNumber: true, unitId: true }, orderBy: { createdAt: "desc" } }),
        prisma.serviceReport.findMany({ where: { kind: SERVICE_REPORT_KIND.DIRECT, unitId: { in: unitIds }, status: { in: SERVICE_REPORT_OPEN_STATUSES } }, select: { id: true, reportNumber: true, unitId: true } }),
      ]);
  res.json({
    units: units.map((u) => ({
      id: u.id,
      serialNo: u.serialNo,
      model: `${u.product.name} (${u.product.model})`,
      site: u.site ? { id: u.site.id, name: u.site.companyName, address: u.site.address, dgModel: u.site.dgModel, dgCapacityKva: u.site.dgCapacityKva != null ? Number(u.site.dgCapacityKva) : null } : null,
      openTicket: tickets.find((t) => t.unitId === u.id) ? { id: tickets.find((t) => t.unitId === u.id)!.id, ticketNumber: tickets.find((t) => t.unitId === u.id)!.ticketNumber } : null,
      openDirectReport: openReports.find((r) => r.unitId === u.id) ?? null,
    })),
  });
});

serviceReportsRouter.get("/:id", async (req: AuthenticatedRequest, res) => {
  const found = await loadWithAccess(req, res, asString(req.params.id));
  if (!found) return;
  const { report } = found;
  const [customer, site, unit] = await Promise.all([
    prisma.customer.findUnique({ where: { id: report.customerId }, select: { name: true } }),
    report.siteId ? prisma.site.findUnique({ where: { id: report.siteId }, select: { companyName: true, address: true, dgModel: true, dgCapacityKva: true } }) : null,
    report.unitId ? prisma.recdUnit.findUnique({ where: { id: report.unitId }, select: { serialNo: true, product: { select: { name: true, model: true } } } }) : null,
  ]);
  const open = report.status === SERVICE_REPORT_STATUS.DRAFT;
  res.json({
    ...toApi(report),
    customerName: customer?.name ?? null,
    amcDetails: report.amcOrder
      ? { ref: amcRef(report.amcOrder.id), poNo: report.amcOrder.poNo, poDate: dateOnly(report.amcOrder.poDate), location: report.amcOrder.location, visitsPerYear: report.amcOrder.amcFrequencyPerYear }
      : null,
    site: site ? { name: site.companyName, address: site.address, dgModel: site.dgModel, dgCapacityKva: site.dgCapacityKva } : null,
    // The serial printed on the report is the snapshot taken when it was written; the live unit only supplies the model.
    unit: report.unitId || report.unitSerialNo ? { serialNo: report.unitSerialNo ?? unit?.serialNo ?? null, model: unit?.product ? `${unit.product.name} (${unit.product.model})` : null } : null,
    permissions: {
      canEdit: found.staff.write && open,
      canSubmit: found.staff.write && open,
      canReopen: found.staff.write && report.status === SERVICE_REPORT_STATUS.AWAITING_SIGNATURE,
      // In-person signing: staff with write access open the signing screen for a report that is awaiting signature. A customer login never signs.
      canCollectSignature: found.staff.write && report.status === SERVICE_REPORT_STATUS.AWAITING_SIGNATURE,
    },
  });
});

// ---------------------------------------------------------------------------
// Create (draft)
// ---------------------------------------------------------------------------

async function createTicketReport(req: AuthenticatedRequest, res: Response) {
  const parsed = createServiceReportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const d = parsed.data;

  const ticket = await prisma.complaint.findUnique({ where: { id: d.complaintId }, select: ticketSelect });
  if (!ticket) return res.status(404).json({ error: "Complaint not found" });
  if (!(await staffAccess(req, ticket)).write) return res.status(403).json({ error: "You cannot create a service report for this ticket" });
  if (ticket.archivedAt) return res.status(409).json({ error: "This ticket is archived, so no new service report can be created for it." });

  // One report in progress per ticket (also a database-level partial unique index). A finished one does not block a new visit.
  const inProgress = await prisma.serviceReport.findFirst({ where: { complaintId: ticket.id, status: { in: SERVICE_REPORT_OPEN_STATUSES } }, select: { id: true, reportNumber: true, status: true } });
  if (inProgress) {
    return res.status(409).json({ error: `Report ${inProgress.reportNumber} for this ticket is still ${inProgress.status.replace(/_/g, " ")}. Finish it first.`, code: "REPORT_IN_PROGRESS", reportId: inProgress.id });
  }

  for (let attempt = 0; attempt < MAX_NUMBER_ATTEMPTS; attempt++) {
    const n = (await prisma.serviceReport.count({ where: { complaintId: ticket.id } })) + 1 + attempt;
    try {
      const created = await prisma.serviceReport.create({
        data: {
          reportNumber: `${ticket.ticketNumber}-R${n}`,
          complaintId: ticket.id,
          // Derived from the TICKET - never from the request.
          customerId: ticket.customerId,
          siteId: ticket.siteId,
          unitId: ticket.unitId,
          createdById: req.auth!.userId,
          visitDate: new Date(`${d.visitDate}T00:00:00.000Z`),
          workPerformed: d.workPerformed,
          findings: d.findings,
          resolution: d.resolution,
          partsUsed: d.partsUsed || null,
          remarks: d.remarks || null,
        },
        include: reportInclude,
      });
      await event(req, created, COMPLAINT_EVENT.SERVICE_REPORT_CREATED, SERVICE_REPORT_STATUS.DRAFT);
      return res.status(201).json(toApi(created));
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") throw err;
      const raced = await prisma.serviceReport.findFirst({ where: { complaintId: ticket.id, status: { in: SERVICE_REPORT_OPEN_STATUSES } }, select: { id: true, reportNumber: true } });
      if (raced) return res.status(409).json({ error: `Report ${raced.reportNumber} was just started for this ticket.`, code: "REPORT_IN_PROGRESS", reportId: raced.id });
      // otherwise a report-number collision: try the next number
    }
  }
  return res.status(409).json({ error: "Could not allocate a report number. Nothing was saved - please try again.", code: "REPORT_NUMBER_CONFLICT" });
}

async function createAmcReport(req: AuthenticatedRequest, res: Response) {
  if ((req.body as Record<string, unknown>).complaintId !== undefined) {
    return res.status(400).json({ error: "A service report belongs to a ticket or to an AMC order, not both." });
  }
  // The AMC boundary comes first, before anything about the order is revealed.
  const p = req.auth!.permissions;
  if (req.auth!.customerId || !(p.has(PERMISSION_KEY.MANAGE_AMC_ORDERS) || p.has(PERMISSION_KEY.MANAGE_COMPLAINTS) || p.has(PERMISSION_KEY.ACT_ASSIGNED_COMPLAINTS))) {
    return res.status(403).json({ error: "You cannot create an AMC service report" });
  }

  if ((req.body as Record<string, unknown>).acknowledgementRequired === false) {
    return res.status(400).json({ error: "Every service report needs the customer's signature.", code: "SIGNATURE_REQUIRED" });
  }
  const parsed = createAmcServiceReportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const d = parsed.data;

  const amc = await prisma.amcOrder.findUnique({ where: { id: d.amcOrderId }, select: { id: true, customerId: true, units: { select: { unitId: true } } } });
  if (!amc) return res.status(404).json({ error: "AMC order not found" });
  // 1. the unit must be covered by THIS AMC order (the AmcOrderUnit link) ...
  if (!amc.units.some((l) => l.unitId === d.unitId)) return res.status(400).json({ error: "That RECD unit is not covered by this AMC order.", code: "UNIT_NOT_IN_AMC" });
  const unit = await prisma.recdUnit.findUnique({
    where: { id: d.unitId },
    select: { id: true, serialNo: true, status: true, siteId: true, order: { select: { customerId: true } }, site: { select: { id: true, regionId: true, vendorId: true } } },
  });
  if (!unit) return res.status(404).json({ error: "RECD unit not found" });
  // 2. ... must belong to the AMC's customer (defence in depth: the link was checked when the AMC was created) ...
  if (unit.order.customerId !== amc.customerId) return res.status(400).json({ error: "That RECD unit does not belong to this AMC order's customer.", code: "UNIT_CUSTOMER_MISMATCH" });
  // 3. ... must carry a serial (it is printed on the report) and still be in service.
  if (!unit.serialNo) return res.status(400).json({ error: "That RECD unit has no serial number yet.", code: "UNIT_NO_SERIAL" });
  if (unit.status !== "active") return res.status(400).json({ error: "That RECD unit is retired.", code: "UNIT_RETIRED" });
  if (!(await amcStaffAccess(req, unit.site, true, unit.id)).write) return res.status(403).json({ error: "You cannot create a service report for this site" });

  const open = await prisma.serviceReport.findFirst({ where: { amcOrderId: amc.id, unitId: unit.id, status: { in: SERVICE_REPORT_OPEN_STATUSES } }, select: { id: true, reportNumber: true, status: true } });
  if (open) {
    return res.status(409).json({ error: `Report ${open.reportNumber} for this unit is still ${open.status.replace(/_/g, " ")}. Finish it first.`, code: "REPORT_IN_PROGRESS", reportId: open.id });
  }

  for (let attempt = 0; attempt < MAX_NUMBER_ATTEMPTS; attempt++) {
    const n = (await prisma.serviceReport.count({ where: { amcOrderId: amc.id } })) + 1 + attempt;
    try {
      const created = await prisma.serviceReport.create({
        data: {
          reportNumber: `${amcRef(amc.id)}-R${n}`,
          kind: SERVICE_REPORT_KIND.AMC,
          amcOrderId: amc.id,
          // Derived from the AMC order and the covered unit - never from the request.
          customerId: amc.customerId,
          siteId: unit.siteId,
          unitId: unit.id,
          unitSerialNo: unit.serialNo,
          acknowledgementRequired: true, // every report needs the customer's signature
          createdById: req.auth!.userId,
          visitDate: new Date(`${d.visitDate}T00:00:00.000Z`),
          workPerformed: d.workPerformed,
          findings: d.findings,
          resolution: d.resolution,
          partsUsed: d.partsUsed || null,
          remarks: d.remarks || null,
        },
        include: reportInclude,
      });
      await event(req, created, COMPLAINT_EVENT.SERVICE_REPORT_CREATED, SERVICE_REPORT_STATUS.DRAFT, null, { acknowledgementRequired: created.acknowledgementRequired, unitSerialNo: created.unitSerialNo });
      return res.status(201).json(toApi(created));
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") throw err;
      const raced = await prisma.serviceReport.findFirst({ where: { amcOrderId: amc.id, unitId: unit.id, status: { in: SERVICE_REPORT_OPEN_STATUSES } }, select: { id: true, reportNumber: true } });
      if (raced) return res.status(409).json({ error: `Report ${raced.reportNumber} was just started for this unit.`, code: "REPORT_IN_PROGRESS", reportId: raced.id });
    }
  }
  return res.status(409).json({ error: "Could not allocate a report number. Nothing was saved - please try again.", code: "REPORT_NUMBER_CONFLICT" });
}

/**
 * A DIRECT report: no ticket, no AMC order. The caller names the RECD unit (DG); the Customer, the Site and the serial snapshot are read from that unit
 * and its order - never from the request. A `customerId` in the body is only a cross-check and is refused when it is not the unit's customer.
 */
async function createDirectReport(req: AuthenticatedRequest, res: Response) {
  // The boundary comes first, before anything about the unit is revealed.
  if (req.auth!.customerId || !req.auth!.permissions.has(PERMISSION_KEY.MANAGE_COMPLAINTS)) {
    return res.status(403).json({ error: "You cannot create a direct service report" });
  }
  if ((req.body as Record<string, unknown> | undefined)?.acknowledgementRequired === false) {
    return res.status(400).json({ error: "Every service report needs the customer's signature.", code: "SIGNATURE_REQUIRED" });
  }
  const parsed = createDirectServiceReportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const d = parsed.data;

  const unit = await prisma.recdUnit.findUnique({
    where: { id: d.unitId },
    select: { id: true, serialNo: true, status: true, siteId: true, order: { select: { customerId: true } }, site: { select: { id: true, regionId: true, vendorId: true } } },
  });
  if (!unit) return res.status(404).json({ error: "RECD unit not found" });
  if (d.customerId && d.customerId !== unit.order.customerId) {
    return res.status(400).json({ error: "That RECD unit does not belong to the selected customer.", code: "CUSTOMER_UNIT_MISMATCH" });
  }
  if (unit.status !== "active") return res.status(400).json({ error: "That RECD unit is retired.", code: "UNIT_RETIRED" });
  if (!unit.siteId || !unit.site) return res.status(400).json({ error: "That RECD unit has no site yet, so a report cannot be recorded against it.", code: "UNIT_NO_SITE" });
  if (!(await directStaffAccess(req, unit.site, unit.id)).write) return res.status(403).json({ error: "You cannot create a service report for this site" });

  const inProgress = await prisma.serviceReport.findFirst({ where: { kind: SERVICE_REPORT_KIND.DIRECT, unitId: unit.id, status: { in: SERVICE_REPORT_OPEN_STATUSES } }, select: { id: true, reportNumber: true, status: true } });
  if (inProgress) {
    return res.status(409).json({ error: `Report ${inProgress.reportNumber} for this unit is still ${inProgress.status.replace(/_/g, " ")}. Finish it first.`, code: "REPORT_IN_PROGRESS", reportId: inProgress.id });
  }

  const ref = `DSR-${unit.id.slice(-8).toUpperCase()}`;
  for (let attempt = 0; attempt < MAX_NUMBER_ATTEMPTS; attempt++) {
    const n = (await prisma.serviceReport.count({ where: { kind: SERVICE_REPORT_KIND.DIRECT, unitId: unit.id } })) + 1 + attempt;
    try {
      const created = await prisma.serviceReport.create({
        data: {
          reportNumber: `${ref}-R${n}`,
          kind: SERVICE_REPORT_KIND.DIRECT,
          // Derived from the RECD unit and its order - never from the request.
          customerId: unit.order.customerId,
          siteId: unit.siteId,
          unitId: unit.id,
          unitSerialNo: unit.serialNo, // optional: null when the unit has no serial ("Not recorded")
          acknowledgementRequired: true, // every report needs the customer's signature
          createdById: req.auth!.userId,
          visitDate: new Date(`${d.visitDate}T00:00:00.000Z`),
          workPerformed: d.workPerformed,
          findings: d.findings,
          resolution: d.resolution,
          partsUsed: d.partsUsed || null,
          remarks: d.remarks || null,
        },
        include: reportInclude,
      });
      await event(req, created, COMPLAINT_EVENT.SERVICE_REPORT_CREATED, SERVICE_REPORT_STATUS.DRAFT, null, { unitSerialNo: created.unitSerialNo, direct: true });
      return res.status(201).json(toApi(created));
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") throw err;
      const raced = await prisma.serviceReport.findFirst({ where: { kind: SERVICE_REPORT_KIND.DIRECT, unitId: unit.id, status: { in: SERVICE_REPORT_OPEN_STATUSES } }, select: { id: true, reportNumber: true } });
      if (raced) return res.status(409).json({ error: `Report ${raced.reportNumber} was just started for this unit.`, code: "REPORT_IN_PROGRESS", reportId: raced.id });
      // otherwise a report-number collision: try the next number
    }
  }
  return res.status(409).json({ error: "Could not allocate a report number. Nothing was saved - please try again.", code: "REPORT_NUMBER_CONFLICT" });
}

serviceReportsRouter.post("/", async (req: AuthenticatedRequest, res) => {
  const body = req.body as Record<string, unknown> | undefined;
  if (body && typeof body === "object" && body.amcOrderId !== undefined) return createAmcReport(req, res);
  if (body && typeof body === "object" && body.complaintId !== undefined) return createTicketReport(req, res);
  // Neither a ticket nor an AMC order named: a direct report (the unit is validated there). A body naming nothing at all is a 400 / 403 from that handler.
  return createDirectReport(req, res);
});

// ---------------------------------------------------------------------------
// Edit / submit / reopen
// ---------------------------------------------------------------------------

serviceReportsRouter.patch("/:id", async (req: AuthenticatedRequest, res) => {
  const parsed = updateServiceReportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const found = await loadWithAccess(req, res, asString(req.params.id));
  if (!found) return;
  const { report } = found;
  if (!found.staff.write) return res.status(403).json({ error: "You cannot edit this report" });
  if (isFinal(report.status)) return res.status(409).json({ error: `A ${report.status} report is final and cannot be edited.`, code: "REPORT_FINAL" });
  if (report.status !== SERVICE_REPORT_STATUS.DRAFT) return res.status(409).json({ error: "This report is awaiting the customer's signature. Reopen it to edit.", code: "REPORT_NOT_DRAFT" });
  if (parsed.data.expectedVersion !== report.version) return staleVersion(res);
  if ((req.body as Record<string, unknown>)?.acknowledgementRequired === false) {
    return res.status(400).json({ error: "Every service report needs the customer's signature.", code: "SIGNATURE_REQUIRED" });
  }

  const { expectedVersion, visitDate, partsUsed, remarks, ...rest } = parsed.data;
  const claimed = await prisma.serviceReport.updateMany({
    // status AND version in the condition: a concurrent submit/edit makes this a no-op instead of an overwrite.
    where: { id: report.id, status: SERVICE_REPORT_STATUS.DRAFT, version: expectedVersion },
    data: {
      ...rest,
      ...(visitDate ? { visitDate: new Date(`${visitDate}T00:00:00.000Z`) } : {}),
      ...(partsUsed !== undefined ? { partsUsed: partsUsed || null } : {}),
      ...(remarks !== undefined ? { remarks: remarks || null } : {}),
      version: { increment: 1 },
    },
  });
  if (claimed.count !== 1) return staleVersion(res);
  const fresh = await prisma.serviceReport.findUniqueOrThrow({ where: { id: report.id }, include: reportInclude });
  await event(req, fresh, EVENT_UPDATED, SERVICE_REPORT_STATUS.DRAFT, SERVICE_REPORT_STATUS.DRAFT);
  res.json(toApi(fresh));
});

/** Everything the PDF needs besides the report row. */
async function pdfContext(report: ReportRow): Promise<Omit<ServiceReportPdfInput, "signerName" | "signedAt" | "signaturePng" | "contentHash" | "finalState" | "submittedAt">> {
  const [customer, site, unit, engineer] = await Promise.all([
    prisma.customer.findUnique({ where: { id: report.customerId }, select: { name: true } }),
    report.siteId ? prisma.site.findUnique({ where: { id: report.siteId }, select: { companyName: true, address: true, dgModel: true, dgCapacityKva: true } }) : null,
    report.unitId ? prisma.recdUnit.findUnique({ where: { id: report.unitId }, select: { serialNo: true, product: { select: { name: true, model: true } } } }) : null,
    prisma.user.findUnique({ where: { id: report.createdById }, select: { name: true } }),
  ]);
  return {
    reportNumber: report.reportNumber,
    kind: report.kind === SERVICE_REPORT_KIND.AMC ? "amc" : report.kind === SERVICE_REPORT_KIND.DIRECT ? "direct" : "ticket",
    ticketNumber: report.complaint?.ticketNumber ?? null,
    amc: report.amcOrder
      ? {
          orderRef: amcRef(report.amcOrder.id),
          poNo: report.amcOrder.poNo,
          poDate: report.amcOrder.poDate,
          typeLabel: AMC_TYPE_LABELS[report.amcOrder.amcType] ?? report.amcOrder.amcType,
          frequencyPerYear: report.amcOrder.amcFrequencyPerYear,
          location: report.amcOrder.location,
        }
      : null,
    customerName: customer?.name ?? "-",
    siteName: site?.companyName ?? null,
    siteAddress: site?.address ?? null,
    // The serial printed is the one recorded when the report was written (AMC) - not whatever the unit row says today.
    recdSerial: report.unitSerialNo ?? unit?.serialNo ?? null,
    recdModel: unit?.product ? `${unit.product.name} (${unit.product.model})` : null,
    dgModel: site?.dgModel ?? null,
    dgCapacityKva: site?.dgCapacityKva != null ? Number(site.dgCapacityKva) : null,
    visitDate: report.visitDate,
    engineerName: engineer?.name ?? report.createdBy.name,
    workPerformed: report.workPerformed,
    findings: report.findings,
    resolution: report.resolution,
    partsUsed: report.partsUsed,
    remarks: report.remarks,
    version: report.version,
  };
}

async function discard(storage: ReportStorage, refs: Array<string | undefined>) {
  for (const ref of refs) {
    if (!ref) continue;
    try {
      await storage.delete(ref);
    } catch (err) {
      console.error("[service-report] could not remove an orphaned file", err instanceof Error ? err.name : "unknown");
    }
  }
}

serviceReportsRouter.post("/:id/submit", async (req: AuthenticatedRequest, res) => {
  const parsed = submitServiceReportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const found = await loadWithAccess(req, res, asString(req.params.id));
  if (!found) return;
  const { report } = found;
  if (!found.staff.write) return res.status(403).json({ error: "You cannot submit this report" });
  // Every report goes to the customer for signature; there is no unsigned finalisation.
  const target = SERVICE_REPORT_STATUS.AWAITING_SIGNATURE;
  if (!canTransitionServiceReport(report.status, target)) {
    return res.status(409).json({ error: `A ${report.status.replace(/_/g, " ")} report cannot be submitted.`, code: "BAD_TRANSITION" });
  }
  if (parsed.data.expectedVersion !== report.version) return staleVersion(res);

  const missing = serviceReportMissingFields(report);
  if (missing.length) return res.status(400).json({ error: `Complete these before submitting: ${missing.join(", ")}.`, missing });

  // A draft written before the unsigned path was withdrawn may still carry acknowledgementRequired = false: it is brought in line
  // here (the fingerprint is taken with the signature required, so the customer can sign exactly what was submitted).
  const contentHash = reportContentHash({ ...report, acknowledgementRequired: true });
  const claimed = await prisma.serviceReport.updateMany({
    where: { id: report.id, status: SERVICE_REPORT_STATUS.DRAFT, version: report.version },
    data: { status: SERVICE_REPORT_STATUS.AWAITING_SIGNATURE, submittedAt: new Date(), submittedById: req.auth!.userId, contentHash, acknowledgementRequired: true },
  });
  if (claimed.count !== 1) return staleVersion(res);
  const fresh = await prisma.serviceReport.findUniqueOrThrow({ where: { id: report.id }, include: reportInclude });
  await event(req, fresh, COMPLAINT_EVENT.SERVICE_REPORT_SUBMITTED, SERVICE_REPORT_STATUS.AWAITING_SIGNATURE, SERVICE_REPORT_STATUS.DRAFT);
  return res.json(toApi(fresh));
});


/** Staff pull a report back from "awaiting signature" to fix it. The version moves on, so a customer who had the old one open cannot sign it. */
serviceReportsRouter.post("/:id/reopen", async (req: AuthenticatedRequest, res) => {
  const parsed = reopenServiceReportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const found = await loadWithAccess(req, res, asString(req.params.id));
  if (!found) return;
  const { report } = found;
  if (!found.staff.write) return res.status(403).json({ error: "You cannot reopen this report" });
  if (!canTransitionServiceReport(report.status, SERVICE_REPORT_STATUS.DRAFT)) {
    return res.status(409).json({ error: isFinal(report.status) ? `A ${report.status} report is final and cannot be reopened.` : "Only a report awaiting signature can be reopened.", code: "BAD_TRANSITION" });
  }
  if (parsed.data.expectedVersion !== report.version) return staleVersion(res);

  const claimed = await prisma.serviceReport.updateMany({
    where: { id: report.id, status: SERVICE_REPORT_STATUS.AWAITING_SIGNATURE, version: report.version },
    data: { status: SERVICE_REPORT_STATUS.DRAFT, version: { increment: 1 }, contentHash: null, submittedAt: null, submittedById: null },
  });
  if (claimed.count !== 1) return staleVersion(res);
  const fresh = await prisma.serviceReport.findUniqueOrThrow({ where: { id: report.id }, include: reportInclude });
  await event(req, fresh, COMPLAINT_EVENT.SERVICE_REPORT_REOPENED, SERVICE_REPORT_STATUS.DRAFT, SERVICE_REPORT_STATUS.AWAITING_SIGNATURE);
  res.json(toApi(fresh));
});

// ---------------------------------------------------------------------------
// Sign (in person, on the staff device)
// ---------------------------------------------------------------------------

const SIGNER_IS_STAFF = "The person signing must be the customer's representative. Enter the customer's own name, not a Platino staff member's.";
const normName = (v: string | null | undefined) => (v ?? "").toLowerCase().replace(/\s+/g, " ").trim();

const SESSION_MESSAGES: Record<string, string> = {
  malformed: "Start the in-person signing first: hand the device to the customer from the signing screen.",
  forged: "Start the in-person signing first: hand the device to the customer from the signing screen.",
  expired: "The signing session has expired. Return to the report and start the in-person signing again.",
  other_report: "This signing session belongs to another report. Return to the report and start the in-person signing again.",
  other_version: "This report changed after the signing was started. Return to the report and start the in-person signing again.",
  other_user: "This signing session was started by another user. Return to the report and start the in-person signing again.",
};

/**
 * Step 1 of in-person signing: staff confirm that the device is now with the customer. Only staff who may write to this report, and only for a report
 * that is awaiting signature and whose content is exactly what was submitted, get a session. Nothing is signed here; it is recorded in the audit trail.
 */
serviceReportsRouter.post("/:id/signing-session", async (req: AuthenticatedRequest, res) => {
  const parsed = startSigningSessionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const found = await loadWithAccess(req, res, asString(req.params.id));
  if (!found) return;
  const { report } = found;
  if (!found.staff.write) return res.status(403).json({ error: "You cannot start the signing of this report" });
  if (report.status !== SERVICE_REPORT_STATUS.AWAITING_SIGNATURE) {
    return res.status(409).json({ error: "Only a report that is awaiting the customer's signature can be signed.", code: "BAD_TRANSITION" });
  }
  if (parsed.data.expectedVersion !== report.version) return staleVersion(res);
  if (serviceReportMissingFields(report).length || !report.contentHash || report.contentHash !== reportContentHash(report)) {
    return res.status(409).json({ error: "This report is not in a signable state. Take it back to draft and submit it again.", code: "REPORT_NOT_SIGNABLE" });
  }
  const session = issueSigningSession({ reportId: report.id, version: report.version, staffId: req.auth!.userId });
  // The signing credential for the customer step (the staff login is not needed on the device after this). Its session id is recorded in the audit event
  // below; that record is what makes it the live session, so it is written strictly (a failure stops the start instead of leaving a credential that cannot work).
  const staffAccount = await authLookup.load(req.auth!.userId);
  const sessionId = newSigningSessionId();
  const credential = issueSigningCredential({ reportId: report.id, version: report.version, staffId: req.auth!.userId, tokenVersion: staffAccount?.tokenVersion ?? 0, sessionId });
  await signingSessionEvent(req, report, EVENT_SIGNING_STARTED, { mode: "in_person", handoffConfirmed: true, expiresAt: session.expiresAt.toISOString(), sessionId });
  res.json({ signingSession: session.token, signingCredential: credential.token, expiresAt: credential.expiresAt.toISOString(), version: report.version });
});

/**
 * Step 2: the customer's signature, captured on the staff device. Needs the staff login that started the session (a customer login is refused),
 * the signing session, the version that was shown, the name the customer typed, the drawn signature and the approval tick. The signature checks,
 * the content-hash check, the PDF, the stored files and the final immutability are exactly those of the earlier flow.
 */
serviceReportsRouter.post("/:id/sign", async (req: SigningRequest, res) => {
  // A customer login cannot sign any more - checked before anything about the report is revealed.
  if (req.auth!.customerId) {
    return res.status(403).json({ error: "Service reports are signed in person, on a Platino staff device. Please ask the Platino engineer to open the signing screen.", code: "IN_PERSON_ONLY" });
  }

  const parsed = signServiceReportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const found = await loadWithAccess(req, res, asString(req.params.id));
  if (!found) return;
  const { report } = found;
  if (!found.staff.write) return res.status(403).json({ error: "You cannot collect the signature for this report" });
  if (report.status === SERVICE_REPORT_STATUS.SIGNED) return res.status(409).json({ error: "This report has already been signed.", code: "ALREADY_SIGNED" });
  if (report.status === SERVICE_REPORT_STATUS.DRAFT) return res.status(409).json({ error: "This report has not been submitted for the customer's signature.", code: "BAD_TRANSITION" });
  if (!canTransitionServiceReport(report.status, SERVICE_REPORT_STATUS.SIGNED) || !report.acknowledgementRequired) {
    return res.status(409).json({ error: "This report does not need a signature or cannot be signed.", code: "BAD_TRANSITION" });
  }
  if (parsed.data.version !== report.version) {
    return res.status(409).json({ error: "This report changed after it was shown to the customer. Please show the latest version before signing.", code: "STALE_VERSION" });
  }
  if (req.signing) {
    // Signing credential (customer step): the gate already proved it is genuine, unexpired, the live session, for THIS report, with the staff account in
    // good standing. Here: the version it was issued for must be the version being signed, and the copy in the body must be the same credential.
    if (req.signing.claims.version !== report.version || parsed.data.signingSession !== req.signing.token) {
      return res.status(401).json(SIGNING_INVALID_ERROR);
    }
  } else {
    // Signing session (staff login): it must be the one this staff login started, for this report and this version, and still fresh.
    const session = checkSigningSession(parsed.data.signingSession, { reportId: report.id, version: report.version, staffId: req.auth!.userId });
    if (!session.ok) return res.status(403).json({ error: SESSION_MESSAGES[session.reason] ?? SESSION_MESSAGES.malformed, code: "SIGNING_SESSION_INVALID" });
  }

  // The signer is the customer's representative: never the logged-in member of staff and never the engineer who wrote the report.
  const staffUser = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { name: true } });
  const signer = normName(parsed.data.signerName);
  if ((staffUser?.name && signer === normName(staffUser.name)) || signer === normName(report.createdBy?.name)) {
    return res.status(400).json({ error: SIGNER_IS_STAFF, code: "SIGNER_IS_STAFF" });
  }

  // The content must still be exactly what was submitted for signature.
  const missing = serviceReportMissingFields(report);
  if (missing.length || !report.contentHash || report.contentHash !== reportContentHash(report)) {
    return res.status(409).json({ error: "This report is not in a signable state. Please take it back to draft and submit it again.", code: "REPORT_NOT_SIGNABLE" });
  }

  const signature = checkSignatureDataUrl(parsed.data.signatureImage);
  if (!signature.ok) return res.status(400).json({ error: signature.reason, code: "BAD_SIGNATURE" });

  const storage = getReportStorage();
  if (!storage) return res.status(503).json({ error: "Signed-report storage is not configured. Please contact Platino service.", code: "STORAGE_NOT_CONFIGURED" });

  const signedAt = new Date();
  let pdf: Buffer;
  try {
    pdf = await buildServiceReportPdf({
      ...(await pdfContext(report)),
      finalState: "signed",
      signerName: parsed.data.signerName,
      signedAt,
      contentHash: report.contentHash,
      signaturePng: signature.bytes,
      capturedByName: staffUser?.name ?? "Platino staff",
    });
  } catch (err) {
    console.error("[service-report] PDF generation failed", err instanceof Error ? err.name : "unknown");
    return res.status(500).json({ error: "The signed PDF could not be created. Nothing was saved - please try again.", code: "PDF_GENERATION_FAILED" });
  }

  // 1. store the files, 2. claim the report in ONE conditional update, 3. on any failure remove the files again.
  let signatureRef: string | undefined;
  let pdfRef: string | undefined;
  let pdfSha256: string;
  try {
    const sig = await storage.put(signature.bytes, "image/png");
    signatureRef = sig.ref;
    const stored = await storage.put(pdf, "application/pdf");
    pdfRef = stored.ref;
    pdfSha256 = stored.sha256;
  } catch (err) {
    console.error("[service-report] storing the signed files failed", err instanceof Error ? err.name : "unknown");
    await discard(storage, [signatureRef, pdfRef]);
    return res.status(502).json({ error: "The signed report could not be stored. Nothing was saved - please try again.", code: "STORAGE_FAILED" });
  }

  let claimedCount: number;
  try {
    const claimed = await prisma.serviceReport.updateMany({
      where: { id: report.id, status: SERVICE_REPORT_STATUS.AWAITING_SIGNATURE, version: report.version },
      data: {
        status: SERVICE_REPORT_STATUS.SIGNED,
        signedAt,
        signedVersion: report.version,
        signerName: parsed.data.signerName,
        // signedById is deliberately left empty: the signer is the customer representative named above (no account), and the staff account that
        // operated the device is recorded in the audit event and on the PDF as the one that captured the signature.
        signedById: null,
        signatureFileId: signatureRef,
        pdfFileId: pdfRef,
        pdfSha256,
      },
    });
    claimedCount = claimed.count;
  } catch (err) {
    await discard(storage, [signatureRef, pdfRef]);
    throw err;
  }
  if (claimedCount !== 1) {
    // Someone else signed (or staff reopened) in the meantime: our files are surplus.
    await discard(storage, [signatureRef, pdfRef]);
    return res.status(409).json({ error: "This report was just signed or changed. Please reload it.", code: "ALREADY_SIGNED" });
  }

  const fresh = await prisma.serviceReport.findUniqueOrThrow({ where: { id: report.id }, include: reportInclude });
  await event(req, fresh, COMPLAINT_EVENT.SERVICE_REPORT_SIGNED, SERVICE_REPORT_STATUS.SIGNED, SERVICE_REPORT_STATUS.AWAITING_SIGNATURE, {
    finalPdfGenerated: true,
    pdfSha256,
    signerName: parsed.data.signerName,
    mode: "in_person",
    capturedById: req.auth!.userId,
    ...(req.signing ? { signingSessionId: req.signing.claims.sessionId, viaSigningCredential: true } : {}),
  });
  // The customer step has no staff login: it gets only the confirmation it needs, not the whole report record.
  if (req.signing) {
    return res.json({ id: fresh.id, reportNumber: fresh.reportNumber, status: fresh.status, version: fresh.version, signedAt: fresh.signedAt, signerName: fresh.signerName });
  }
  res.json(toApi(fresh));
});

// ---------------------------------------------------------------------------
// Customer step of the in-person signing (signing credential only, see middleware/signingCredential.ts)
// ---------------------------------------------------------------------------

/** What the customer is shown and nothing more: no history, no staff-only fields, no file references. Same wording and shape as the staff detail view for these fields. */
async function signingView(report: ReportRow) {
  const [customer, site, unit] = await Promise.all([
    prisma.customer.findUnique({ where: { id: report.customerId }, select: { name: true } }),
    report.siteId ? prisma.site.findUnique({ where: { id: report.siteId }, select: { companyName: true, address: true, dgModel: true, dgCapacityKva: true } }) : null,
    report.unitId ? prisma.recdUnit.findUnique({ where: { id: report.unitId }, select: { serialNo: true, product: { select: { name: true, model: true } } } }) : null,
  ]);
  return {
    id: report.id,
    reportNumber: report.reportNumber,
    kind: report.kind,
    ticketNumber: report.complaint?.ticketNumber ?? null,
    amc: report.amcOrder ? { ref: amcRef(report.amcOrder.id) } : null,
    status: report.status,
    version: report.version,
    visitDate: dateOnly(report.visitDate),
    workPerformed: report.workPerformed,
    findings: report.findings,
    resolution: report.resolution,
    partsUsed: report.partsUsed,
    remarks: report.remarks,
    engineer: { name: report.createdBy?.name ?? "" },
    customerName: customer?.name ?? null,
    site: site ? { name: site.companyName, address: site.address, dgModel: site.dgModel, dgCapacityKva: site.dgCapacityKva } : null,
    unit: report.unitId || report.unitSerialNo ? { serialNo: report.unitSerialNo ?? unit?.serialNo ?? null, model: unit?.product ? `${unit.product.name} (${unit.product.model})` : null } : null,
  };
}

/** The signing credential's way to read the report it was issued for. Only while the report is still exactly what was submitted and is awaiting the signature. */
serviceReportsRouter.get("/:id/signing-view", async (req: SigningRequest, res) => {
  if (!req.signing) return res.status(403).json({ error: "This request needs a signing credential.", code: "SIGNING_CREDENTIAL_REQUIRED" });
  const found = await loadWithAccess(req, res, asString(req.params.id));
  if (!found) return;
  const { report } = found;
  if (!found.staff.write) return res.status(403).json({ error: "You cannot collect the signature for this report" });
  if (report.status !== SERVICE_REPORT_STATUS.AWAITING_SIGNATURE) {
    return res.status(409).json({ error: "This report is not waiting for a signature.", code: "BAD_TRANSITION" });
  }
  if (req.signing.claims.version !== report.version) return res.status(401).json(SIGNING_INVALID_ERROR);
  if (serviceReportMissingFields(report).length || !report.contentHash || report.contentHash !== reportContentHash(report)) {
    return res.status(409).json({ error: "This report is not in a signable state. Please hand the device back to Platino staff.", code: "REPORT_NOT_SIGNABLE" });
  }
  res.setHeader("Cache-Control", "private, no-store");
  res.json(await signingView(report));
});

/** Ends the signing session at once (the credential stops working immediately). Harmless to anyone: it only closes the signing. */
serviceReportsRouter.post("/:id/signing-session/cancel", async (req: SigningRequest, res) => {
  if (!req.signing) return res.status(403).json({ error: "This request needs a signing credential.", code: "SIGNING_CREDENTIAL_REQUIRED" });
  const report = await prisma.serviceReport.findUnique({ where: { id: asString(req.params.id) }, include: reportInclude });
  if (!report) return res.status(404).json(NOT_FOUND);
  await signingSessionEvent(req, report, EVENT_SIGNING_CANCELLED, { mode: "in_person", sessionId: req.signing.claims.sessionId, viaSigningCredential: true });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Download / view the final files
// ---------------------------------------------------------------------------

async function sendStoredFile(req: AuthenticatedRequest, res: Response, kind: "pdf" | "signature") {
  const found = await loadWithAccess(req, res, asString(req.params.id));
  if (!found) return;
  const { report } = found;
  const ref = kind === "pdf" ? report.pdfFileId : report.signatureFileId;
  const ready = kind === "pdf" ? isFinal(report.status) : report.status === SERVICE_REPORT_STATUS.SIGNED;
  if (!ready || !ref) return res.status(409).json({ error: kind === "pdf" ? "This report has not been finalised yet." : "This report has not been signed.", code: "NOT_SIGNED" });

  const storage = getReportStorage();
  if (!storage) return res.status(503).json({ error: "Signed-report storage is not configured. Please contact Platino service.", code: "STORAGE_NOT_CONFIGURED" });

  let file: Awaited<ReturnType<ReportStorage["get"]>>;
  try {
    file = await storage.get(ref);
  } catch (err) {
    console.error("[service-report] reading a stored file failed", err instanceof Error ? err.name : "unknown");
    return res.status(502).json({ error: "The signed report could not be read right now. Please try again.", code: "STORAGE_FAILED" });
  }
  if (!file) return res.status(404).json({ error: "The signed file is missing. Please contact Platino service.", code: "FILE_MISSING" });
  if (kind === "pdf" && (sha256Hex(file.bytes) !== report.pdfSha256 || file.sha256 !== report.pdfSha256)) {
    console.error("[service-report] stored PDF failed its integrity check", { reportId: report.id });
    return res.status(500).json({ error: "The stored report failed its integrity check. Please contact Platino service.", code: "FILE_INTEGRITY" });
  }

  const inline = asOptionalString(req.query.disposition) === "inline";
  const name = kind === "pdf" ? `service-report-${report.reportNumber}.pdf` : `signature-${report.reportNumber}.png`;
  res.setHeader("Content-Type", kind === "pdf" ? "application/pdf" : "image/png");
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${name.replace(/[^A-Za-z0-9._-]/g, "_")}"`);
  res.setHeader("Content-Length", String(file.bytes.length));
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(file.bytes);
}

serviceReportsRouter.get("/:id/pdf", (req: AuthenticatedRequest, res) => sendStoredFile(req, res, "pdf"));
serviceReportsRouter.get("/:id/signature", (req: AuthenticatedRequest, res) => sendStoredFile(req, res, "signature"));
