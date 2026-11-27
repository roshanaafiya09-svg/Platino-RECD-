"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { SERVICE_REPORT_KIND, SERVICE_REPORT_STATUS, SERVICE_REPORT_STATUS_LABELS, type ServiceReportStatus } from "@recd/shared";
import { api } from "@/lib/apiClient";
import { apiErrorMessage } from "@/lib/apiError";
import { downloadReportPdf, withPdfFallbackHint } from "@/lib/reportFiles";
import SharePdfButton from "@/components/SharePdfButton";
import { reportKindLabel, reportKindPill, reportStatusPill } from "@/lib/serviceReportUi";
import DirectReportForm from "./DirectReportForm";
import { useAuth } from "@/components/AuthContext";
import { EMPTY_REPORT_FILTERS, REPORT_LIST_PAGE_SIZE, cleanReportId, pageRange, reportListQuery, reportSource, type ReportListFilters } from "@/lib/serviceReportList";

interface Row {
  id: string;
  reportNumber: string;
  kind: "ticket" | "amc" | "direct";
  ticketNumber: string | null;
  amc: { ref: string } | null;
  customerId?: string;
  siteId?: string | null;
  unitId?: string | null;
  customerName?: string;
  siteName?: string | null;
  unitSerial?: string | null;
  unitSerialNo: string | null;
  status: ServiceReportStatus;
  visitDate: string;
  engineer: { name: string };
  pdfAvailable: boolean;
}

/**
 * All service reports the signed-in user may see. Staff: the scoped list from GET /service-reports (their role and region / vendor / assignment
 * decide the rows, on the server), with status, kind and free-text filters. Customers no longer have this page (they sign in person on a staff device).
 * Nothing here widens access - the API authorises every row.
 */
export default function AllServiceReports() {
  const { user, hasPermission } = useAuth();
  // The server decides who may create (manage_complaints holders within their scope); the button is only offered to them.
  const canCreateDirect = hasPermission("manage_complaints");
  const [showNew, setShowNew] = useState(false);
  // A Customer, Site or DG (RECD unit) page links here with ?customerId= / ?siteId= / ?unitId=; the API still limits the rows to what the user may see.
  const params = useSearchParams();
  const [filters, setFilters] = useState<ReportListFilters>({
    ...EMPTY_REPORT_FILTERS,
    customerId: cleanReportId(params.get("customerId")),
    siteId: cleanReportId(params.get("siteId")),
    unitId: cleanReportId(params.get("unitId")),
  });
  const [typed, setTyped] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!user) return;
    setError(null);
    api<{ reports: Row[]; total: number }>(`/service-reports?${reportListQuery(filters)}`)
      .then((r) => {
        setRows(r.reports);
        setTotal(r.total);
      })
      .catch((err) => {
        setRows([]);
        setTotal(0);
        setError(apiErrorMessage(err, "Could not load the service reports."));
      });
  }, [user, filters]);
  useEffect(load, [load]);

  async function download(r: Row) {
    setDownloadError(null);
    try {
      await downloadReportPdf(r.id, r.reportNumber);
    } catch (err) {
      setDownloadError(withPdfFallbackHint(apiErrorMessage(err, "Could not download the report.")));
    }
  }

  const set = (patch: Partial<ReportListFilters>) => setFilters((f) => ({ ...f, offset: 0, ...patch }));

  return (
    <div className="space-y-5 max-w-5xl" data-testid="all-service-reports">
      <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight" style={{ color: "var(--text-heading)" }}>Service reports</h1>
        <p className="mt-1 text-sm text-gray-500">
          Service reports you are allowed to see. Create one directly with + New Service Report (choose the customer and the DG), or start it from an existing service ticket (Complaints → Service reports) or AMC order (AMC Order → Service reports). Every report is signed by the customer in person, on the device you hand over after you submit it.
        </p>
      </div>
      {canCreateDirect && (
        <button type="button" onClick={() => setShowNew((v) => !v)} className="btn-primary px-4 py-2 text-sm" data-testid="new-service-report-button">
          + New Service Report
        </button>
      )}
      </div>

      {canCreateDirect && showNew && <DirectReportForm onClose={() => setShowNew(false)} />}

        <form
          className="flex flex-wrap items-end gap-2 rounded-xl border border-gray-200 bg-white p-3"
          data-testid="report-filters"
          onSubmit={(e) => {
            e.preventDefault();
            set({ q: typed });
          }}
        >
          <div>
            <label className="block text-[11px] font-medium text-gray-500 mb-1">Search</label>
            <input
              className="field"
              placeholder="Report, ticket, serial, customer, site"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              aria-label="Search service reports"
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-gray-500 mb-1">Status</label>
            <select className="field" value={filters.status} onChange={(e) => set({ status: e.target.value })} aria-label="Status">
              <option value="">All</option>
              {Object.values(SERVICE_REPORT_STATUS).map((s) => (
                <option key={s} value={s}>{SERVICE_REPORT_STATUS_LABELS[s]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-medium text-gray-500 mb-1">Type</label>
            <select className="field" value={filters.kind} onChange={(e) => set({ kind: e.target.value })} aria-label="Type">
              <option value="">Direct, ticket and AMC</option>
              <option value={SERVICE_REPORT_KIND.DIRECT}>Direct reports</option>
              <option value={SERVICE_REPORT_KIND.TICKET}>Ticket reports</option>
              <option value={SERVICE_REPORT_KIND.AMC}>AMC reports</option>
            </select>
          </div>
          <button type="submit" className="rounded-lg border border-gray-300 px-3 py-2 text-xs font-medium hover:bg-gray-50">Search</button>
          {(filters.customerId || filters.siteId || filters.unitId) && (
            <span className="flex flex-wrap items-center gap-2 text-xs" data-testid="report-scope-filters">
              {filters.customerId && <span className="rounded-full bg-gray-100 px-2 py-1">Customer: {rows?.[0]?.customerName ?? "selected customer"}</span>}
              {filters.siteId && <span className="rounded-full bg-gray-100 px-2 py-1">Site: {rows?.[0]?.siteName ?? "selected site"}</span>}
              {filters.unitId && <span className="rounded-full bg-gray-100 px-2 py-1">DG / RECD unit: {rows?.[0]?.unitSerial ?? rows?.[0]?.unitSerialNo ?? "selected unit"}</span>}
            </span>
          )}
          {(filters.q || filters.status || filters.kind || filters.customerId || filters.siteId || filters.unitId) && (
            <button type="button" className="text-xs font-medium text-gray-500 hover:underline" onClick={() => { setTyped(""); setFilters(EMPTY_REPORT_FILTERS); }}>
              Clear filters
            </button>
          )}
        </form>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      {downloadError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{downloadError}</p>}
      {rows === null && <p className="text-sm text-gray-500" data-testid="reports-loading">Loading service reports…</p>}
      {rows && rows.length === 0 && !error && (
        <div className="rounded-xl border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500" data-testid="reports-empty">
          No service reports found.
        </div>
      )}

      {rows && rows.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white table-desktop">
          <table className="min-w-full text-sm" data-testid="reports-table">
            <thead className="bg-gray-50 text-left text-[11px] uppercase text-gray-500">
              <tr>
                <th className="px-3 py-2">Report</th>
                <th className="px-3 py-2">For</th>
                <th className="px-3 py-2">Customer / site</th>
                <th className="px-3 py-2">RECD serial</th>
                <th className="px-3 py-2">Visit</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-gray-100" data-testid={`report-row-${r.reportNumber}`}>
                  <td className="px-3 py-2">
                    <Link href={`/service-reports/${r.id}`} className="font-mono font-bold text-[var(--theme-primary)] hover:underline">{r.reportNumber}</Link>
                  </td>
                  <td className="px-3 py-2">
                    <span className={reportKindPill(r.kind)} data-testid={`report-kind-${r.reportNumber}`}>{reportKindLabel(r.kind)}</span>
                    <div className="mt-0.5 text-xs text-gray-500">{reportSource(r)}</div>
                  </td>
                    <td className="px-3 py-2">
                      <div>{r.customerName ?? "-"}</div>
                      <div className="text-xs text-gray-500">{r.siteName ?? "No site"}</div>
                    </td>
                  <td className="px-3 py-2 font-mono text-xs">{r.unitSerial ?? r.unitSerialNo ?? (r.kind === "direct" ? "Not recorded" : "Serial not entered")}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{r.visitDate}<div className="text-xs text-gray-500">{r.engineer.name}</div></td>
                  <td className="px-3 py-2"><span className={reportStatusPill(r.status)}>{SERVICE_REPORT_STATUS_LABELS[r.status] ?? r.status}</span></td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {r.pdfAvailable && (
                      <button onClick={() => download(r)} className="mr-3 text-xs font-medium text-[var(--theme-accent)] hover:underline">
                        PDF
                      </button>
                    )}
                    <Link href={`/service-reports/${r.id}`} className="text-xs font-medium text-gray-600 hover:underline">Open</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Phones: one card per report - status, PDF and Open are all on the card, so nothing needs sideways scrolling. */}
      {rows && rows.length > 0 && (
        <div className="cards-mobile" data-testid="reports-mobile-cards">
          {rows.map((r) => (
            <div key={r.id} className="data-card" data-testid={`report-card-${r.reportNumber}`}>
              <div className="flex items-start justify-between gap-3 mb-2">
                <Link href={`/service-reports/${r.id}`} className="font-mono text-sm font-bold text-[var(--theme-primary)] hover:underline">{r.reportNumber}</Link>
                <span className={reportStatusPill(r.status)}>{SERVICE_REPORT_STATUS_LABELS[r.status] ?? r.status}</span>
              </div>
              <p className="flex flex-wrap items-center gap-2">
                <span className={reportKindPill(r.kind)}>{reportKindLabel(r.kind)}</span>
                <span className="text-xs text-gray-500">{reportSource(r)}</span>
              </p>
              <p className="mt-2 text-sm font-semibold text-gray-900">{r.customerName ?? "-"}</p>
              <p className="text-xs text-gray-500">{r.siteName ?? "No site"}</p>
              <div className="mt-2">
                <div className="data-card-row"><span className="label">RECD serial</span><span className="value font-mono text-xs">{r.unitSerial ?? r.unitSerialNo ?? (r.kind === "direct" ? "Not recorded" : "Serial not entered")}</span></div>
                <div className="data-card-row"><span className="label">Visit</span><span className="value">{r.visitDate} · {r.engineer.name}</span></div>
              </div>
              <div className="mt-3 flex gap-2">
                {r.pdfAvailable && (
                  <button onClick={() => download(r)} className="flex-1 rounded-lg border border-gray-300 min-h-[44px] px-3 py-2 text-xs font-semibold text-[var(--theme-accent)] hover:bg-gray-50">
                    PDF
                  </button>
                )}
                {r.pdfAvailable && (
                  <SharePdfButton reportId={r.id} reportNumber={r.reportNumber} label="Share" wrapperClassName="flex-1" className="w-full rounded-lg border border-gray-300 min-h-[44px] px-3 py-2 text-xs font-semibold text-[var(--theme-accent)] hover:bg-gray-50" />
                )}
                <Link href={`/service-reports/${r.id}`} className="flex min-h-[44px] flex-1 items-center justify-center rounded-lg border border-gray-300 px-3 py-2 text-center text-xs font-semibold text-gray-700 hover:bg-gray-50">Open</Link>
              </div>
            </div>
          ))}
        </div>
      )}

      {rows && total > 0 && (
        <div className="flex items-center justify-between text-xs text-gray-500" data-testid="reports-paging">
          <span>{pageRange(filters.offset, rows.length, total)}</span>
          <span className="flex gap-3">
            <button disabled={filters.offset === 0} onClick={() => setFilters((f) => ({ ...f, offset: Math.max(0, f.offset - REPORT_LIST_PAGE_SIZE) }))} className="font-medium disabled:opacity-40">Previous</button>
            <button disabled={filters.offset + rows.length >= total} onClick={() => setFilters((f) => ({ ...f, offset: f.offset + REPORT_LIST_PAGE_SIZE }))} className="font-medium disabled:opacity-40">Next</button>
          </span>
        </div>
      )}
    </div>
  );
}
