import { SERVICE_REPORT_KIND, SERVICE_REPORT_STATUS } from "@recd/shared";

export const REPORT_LIST_PAGE_SIZE = 25;

export interface ReportListFilters {
  status: string;
  kind: string;
  q: string;
  /** Narrow to one Customer / Site / DG (RECD unit). Set from the Customer, Site and RECD unit pages; the API still limits them to what the caller may see. */
  customerId: string;
  siteId: string;
  unitId: string;
  offset: number;
}

export const EMPTY_REPORT_FILTERS: ReportListFilters = { status: "", kind: "", q: "", customerId: "", siteId: "", unitId: "", offset: 0 };

/** Ids are opaque cuid-style strings; anything else is dropped rather than sent. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const cleanReportId = (v: string | null | undefined): string => (v && ID.test(v) ? v : "");

/** The query string for GET /service-reports (staff list). Empty / unknown filter values are left out; the API narrows by the caller's own scope on top. */
export function reportListQuery(f: ReportListFilters): string {
  const p = new URLSearchParams();
  if ((Object.values(SERVICE_REPORT_STATUS) as string[]).includes(f.status)) p.set("status", f.status);
  if ((Object.values(SERVICE_REPORT_KIND) as string[]).includes(f.kind)) p.set("kind", f.kind);
  for (const [key, value] of [["customerId", f.customerId], ["siteId", f.siteId], ["unitId", f.unitId]] as const) {
    if (cleanReportId(value)) p.set(key, value);
  }
  const q = f.q.trim();
  if (q) p.set("q", q.slice(0, 100));
  p.set("limit", String(REPORT_LIST_PAGE_SIZE));
  p.set("offset", String(Math.max(0, Math.floor(f.offset) || 0)));
  return p.toString();
}

export interface ReportListRow {
  kind: "ticket" | "amc" | "direct";
  ticketNumber: string | null;
  amc: { ref: string } | null;
}

/** What the row belongs to: the ticket number, the AMC reference, or "Direct report" (recorded against a RECD unit with no ticket or AMC order). */
export function reportSource(r: ReportListRow): string {
  if (r.kind === "direct") return "Direct report";
  if (r.kind === "amc") return r.amc?.ref ? `AMC ${r.amc.ref}` : "AMC";
  return r.ticketNumber ?? "Ticket";
}

/** "1-25 of 60", "0 of 0" - the range shown under the list. */
export function pageRange(offset: number, shown: number, total: number): string {
  if (total === 0 || shown === 0) return "0 of 0";
  return `${offset + 1}-${offset + shown} of ${total}`;
}
