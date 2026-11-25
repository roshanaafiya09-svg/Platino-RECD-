"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SERVICE_REPORT_LIMITS } from "@recd/shared";
import { api } from "@/lib/apiClient";
import { apiErrorMessage } from "@/lib/apiError";

interface CustomerOption { id: string; name: string }
export interface DirectUnitOption {
  id: string;
  serialNo: string | null;
  model: string;
  site: { id: string; name: string | null; address: string | null; dgModel: string | null; dgCapacityKva: number | null } | null;
  openTicket: { id: string; ticketNumber: string } | null;
  openDirectReport: { id: string; reportNumber: string } | null;
}

const today = () => new Date().toISOString().slice(0, 10);

/** How a unit reads in the list: the serial, or "Not recorded" when the unit has none yet. */
export const unitLabel = (u: Pick<DirectUnitOption, "serialNo" | "model">) => `${u.serialNo ?? "Not recorded"} - ${u.model}`;

/**
 * "+ New Service Report": record a visit directly against a Customer and one of their RECD units (DG), without a ticket or AMC order.
 * Only the customer and the unit are chosen here. The Site is READ-ONLY and comes from the unit; the server derives the customer, site and serial
 * from the unit again and refuses a mismatch, so this form cannot save an unrelated combination. The report is saved as a draft; it is submitted
 * for the customer's signature on the next screen, exactly like a ticket or AMC report.
 */
export default function DirectReportForm({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [customers, setCustomers] = useState<CustomerOption[] | null>(null);
  const [customerId, setCustomerId] = useState("");
  const [units, setUnits] = useState<DirectUnitOption[] | null>(null);
  const [unitId, setUnitId] = useState("");
  const [form, setForm] = useState({ visitDate: today(), workPerformed: "", findings: "", resolution: "", partsUsed: "", remarks: "" });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ customers: CustomerOption[] }>("/service-reports/direct-options")
      .then((r) => setCustomers(r.customers))
      .catch((err) => {
        setCustomers([]);
        setLoadError(apiErrorMessage(err, "Could not load the customers."));
      });
  }, []);

  function chooseCustomer(id: string) {
    setCustomerId(id);
    setUnitId("");
    setUnits(null);
    setError(null);
    if (!id) return;
    api<{ units: DirectUnitOption[] }>(`/service-reports/direct-options?customerId=${encodeURIComponent(id)}`)
      .then((r) => setUnits(r.units))
      .catch((err) => {
        setUnits([]);
        setLoadError(apiErrorMessage(err, "Could not load the RECD units."));
      });
  }

  const unit = units?.find((u) => u.id === unitId) ?? null;
  const blocked = !!unit?.openDirectReport;
  const missing = !customerId || !unitId || !form.visitDate;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (missing || blocked) return;
    setSaving(true);
    setError(null);
    try {
      // Only the unit (and the customer as a cross-check) is sent: the site and serial are derived by the server.
      const created = await api<{ id: string }>("/service-reports", { method: "POST", body: JSON.stringify({ customerId, unitId, ...form }) });
      router.push(`/service-reports/${created.id}`);
    } catch (err) {
      setError(apiErrorMessage(err, "Could not start the report."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="rounded-xl border border-gray-200 bg-white p-4 space-y-4" data-testid="direct-report-form">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">New service report</h2>
          <p className="text-[11px] text-gray-500">Choose the customer and the DG (RECD unit). The site is filled in from the unit. The report is saved as a draft, then submitted for the customer&apos;s signature.</p>
        </div>
        <button type="button" onClick={onClose} className="text-xs font-medium text-gray-500 hover:underline">Cancel</button>
      </div>

      {loadError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{loadError}</p>}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Customer</label>
          <select required className="field w-full" value={customerId} onChange={(e) => chooseCustomer(e.target.value)} data-testid="direct-customer-select" aria-label="Customer">
            <option value="">{customers === null ? "Loading customers…" : "Choose a customer…"}</option>
            {(customers ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {customers && customers.length === 0 && !loadError && <p className="mt-1 text-[11px] text-amber-600">There is no customer with an active RECD unit that you may report on.</p>}
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">DG / RECD unit</label>
          <select required disabled={!customerId} className="field w-full" value={unitId} onChange={(e) => setUnitId(e.target.value)} data-testid="direct-unit-select" aria-label="DG / RECD unit">
            <option value="">{!customerId ? "Choose a customer first" : units === null ? "Loading units…" : "Choose a unit…"}</option>
            {(units ?? []).map((u) => <option key={u.id} value={u.id}>{unitLabel(u)}</option>)}
          </select>
          {customerId && units && units.length === 0 && <p className="mt-1 text-[11px] text-amber-600">This customer has no active RECD unit at a site you may report on.</p>}
        </div>
      </div>

      {unit && (
        <dl className="grid gap-x-6 gap-y-2 rounded-lg bg-gray-50 p-3 text-sm sm:grid-cols-2" data-testid="direct-site-card">
          <div>
            <dt className="text-xs text-gray-500">Site (from the selected unit)</dt>
            <dd className="font-medium text-gray-800" data-testid="direct-site-name">{unit.site?.name ?? "-"}</dd>
            <dd className="text-xs text-gray-500">{unit.site?.address ?? ""}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">DG / RECD</dt>
            <dd className="font-medium text-gray-800">{[unit.site?.dgModel, unit.site?.dgCapacityKva != null ? `${unit.site.dgCapacityKva} kVA` : null].filter(Boolean).join(", ") || "-"}</dd>
            <dd className="text-xs text-gray-500" data-testid="direct-serial">Serial: {unit.serialNo ?? "Not recorded"} · {unit.model}</dd>
          </div>
        </dl>
      )}

      {unit?.openTicket && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800" data-testid="direct-open-ticket-hint">
          An open service ticket already exists for this DG. You may create the Service Report from that ticket instead.{" "}
          <Link href={`/service-reports?complaintId=${unit.openTicket.id}`} className="font-medium underline">Open {unit.openTicket.ticketNumber}</Link>
        </p>
      )}
      {unit?.openDirectReport && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="direct-open-report-block">
          Report {unit.openDirectReport.reportNumber} for this DG is still in progress. Finish it first.{" "}
          <Link href={`/service-reports/${unit.openDirectReport.id}`} className="font-medium underline">Open it</Link>
        </p>
      )}

      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Service visit date</label>
        <input type="date" required max={today()} className="field" value={form.visitDate} onChange={(e) => setForm({ ...form, visitDate: e.target.value })} />
      </div>
      {([
        ["workPerformed", "Work performed"],
        ["findings", "Findings / observations"],
        ["resolution", "Resolution / outcome"],
      ] as const).map(([key, label]) => (
        <div key={key}>
          <label className="block text-xs font-medium text-gray-500 mb-1">{label}</label>
          <textarea rows={3} maxLength={SERVICE_REPORT_LIMITS.TEXT_MAX} className="field w-full" value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
        </div>
      ))}
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Parts used (optional)</label>
        <input className="field w-full" maxLength={SERVICE_REPORT_LIMITS.TEXT_MAX} value={form.partsUsed} onChange={(e) => setForm({ ...form, partsUsed: e.target.value })} />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Remarks (optional)</label>
        <textarea rows={2} maxLength={SERVICE_REPORT_LIMITS.TEXT_MAX} className="field w-full" value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} />
      </div>

      {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600" data-testid="direct-report-error">{error}</p>}
      <p className="text-[11px] text-gray-400">Saved as a draft first. You can review it and submit it for the customer&apos;s signature on the next screen.</p>
      <button type="submit" disabled={saving || missing || blocked} className="btn-primary px-4 py-2 text-sm disabled:opacity-50" data-testid="direct-report-save">
        {saving ? "Saving…" : "Save draft"}
      </button>
    </form>
  );
}
