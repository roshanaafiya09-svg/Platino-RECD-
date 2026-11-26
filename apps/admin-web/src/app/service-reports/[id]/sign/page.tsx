"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { SERVICE_REPORT_LIMITS, SERVICE_REPORT_STATUS, type ServiceReportStatus } from "@recd/shared";
import { api, ApiRequestError } from "@/lib/apiClient";
import { apiErrorMessage } from "@/lib/apiError";
import SignaturePad from "@/components/SignaturePad";
import { downloadReportPdf, openReportPdf } from "@/lib/reportFiles";

interface ReportDetail {
  id: string;
  reportNumber: string;
  kind: "ticket" | "amc" | "direct";
  complaintId: string | null;
  ticketNumber: string | null;
  amc: { id: string; ref: string; poNo: string; type: string; typeLabel: string } | null;
  status: ServiceReportStatus;
  version: number;
  visitDate: string;
  workPerformed: string;
  findings: string;
  resolution: string;
  partsUsed: string | null;
  remarks: string | null;
  engineer: { id: string; name: string };
  signedAt: string | null;
  signerName: string | null;
  pdfAvailable: boolean;
  customerName: string | null;
  site: { name: string | null; address: string | null; dgModel: string | null; dgCapacityKva: string | number | null } | null;
  unit: { serialNo: string | null; model: string | null } | null;
  permissions: { canCollectSignature: boolean };
}

type Stage = "handoff" | "customer" | "done";

/**
 * IN-PERSON SIGNING (/service-reports/<id>/sign). The page a member of staff lands on right after "Submit for customer signature", and the one
 * "Open the customer signing screen" returns to. It is shown full screen, without the application menu, and has three steps on ONE device:
 *   1. handoff  - addressed to STAFF: give the device to the customer, who signs personally; staff never draw, type or approve for them.
 *                 Pressing the button tells the server the device is with the customer and starts a short signing session.
 *   2. customer - addressed to the CUSTOMER: review the report, type YOUR OWN name (the box starts empty), draw YOUR signature, tick the approval.
 *   3. done     - addressed to STAFF again: the confirmation, the signed PDF and the way back.
 * The server re-checks everything (the signing session, the report version, the signature image, that the signer is not the staff member).
 */
export default function InPersonSigningPage() {
  const { id } = useParams<{ id: string }>();
  const [report, setReport] = useState<ReportDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>("handoff");
  const [session, setSession] = useState<string | null>(null);
  const [signerName, setSignerName] = useState("");
  const [signatureImage, setSignatureImage] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<null | "start" | "sign" | "download">(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    return api<ReportDetail>(`/service-reports/${id}`)
      .then((r) => {
        setReport(r);
        if (r.status === SERVICE_REPORT_STATUS.SIGNED) setStage("done");
        return r;
      })
      .catch((err) => {
        setLoadError(apiErrorMessage(err, "This report could not be loaded."));
        return null;
      });
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  function backToHandoff(message: string) {
    // The session, the typed name and the drawing belong to one hand-over: start again from the hand-over step with fresh data.
    setSession(null);
    setSignerName("");
    setSignatureImage(null);
    setConfirm(false);
    setStage("handoff");
    setError(message);
    load();
  }

  async function startSigning() {
    if (!report) return;
    setBusy("start");
    setError(null);
    try {
      const r = await api<{ signingSession: string }>(`/service-reports/${id}/signing-session`, {
        method: "POST",
        body: JSON.stringify({ expectedVersion: report.version, handoffConfirmed: true }),
      });
      setSession(r.signingSession);
      setStage("customer");
    } catch (err) {
      setError(apiErrorMessage(err, "The signing could not be started."));
      if (err instanceof ApiRequestError && (err.body.code === "STALE_VERSION" || err.body.code === "BAD_TRANSITION" || err.body.code === "REPORT_NOT_SIGNABLE")) load();
    } finally {
      setBusy(null);
    }
  }

  async function signNow() {
    if (!report || !session || !signatureImage) return;
    setBusy("sign");
    setError(null);
    try {
      await api(`/service-reports/${id}/sign`, {
        method: "POST",
        body: JSON.stringify({ signerName, signatureImage, version: report.version, confirm: true, signingSession: session }),
      });
      setSession(null);
      setSignatureImage(null);
      setStage("done");
      await load();
    } catch (err) {
      const code = err instanceof ApiRequestError ? err.body.code : undefined;
      const text = apiErrorMessage(err, "The report could not be signed. Nothing was saved.");
      if (code === "STALE_VERSION" || code === "SIGNING_SESSION_INVALID" || code === "ALREADY_SIGNED") backToHandoff(text);
      else setError(text); // e.g. a name that is not the customer's, or a signature that is too small: the customer can correct it and try again
    } finally {
      setBusy(null);
    }
  }

  async function download(open: boolean) {
    if (!report) return;
    setBusy("download");
    setError(null);
    try {
      if (open) await openReportPdf(report.id);
      else await downloadReportPdf(report.id, report.reportNumber);
    } catch (err) {
      setError(apiErrorMessage(err, "The signed report could not be downloaded."));
    } finally {
      setBusy(null);
    }
  }

  const backHref = report ? `/service-reports/${report.id}` : "/service-reports";

  if (loadError) {
    return (
      <div className="mx-auto max-w-xl space-y-3 p-6" data-testid="signing-error">
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{loadError}</p>
        <Link href="/service-reports" className="text-sm font-medium text-[var(--theme-accent)]">Back to the service reports</Link>
      </div>
    );
  }
  if (!report) return <p className="p-6 text-sm text-gray-500" data-testid="signing-loading">Loading report…</p>;

  const canSignNow = !!signatureImage && signerName.trim().length >= SERVICE_REPORT_LIMITS.SIGNER_NAME_MIN && confirm && busy === null;

  // ---- Not in a state that can be signed in person
  if (stage !== "done" && report.status !== SERVICE_REPORT_STATUS.AWAITING_SIGNATURE) {
    return (
      <div className="mx-auto max-w-xl space-y-3 p-6" data-testid="signing-not-ready">
        <h1 className="text-xl font-semibold">{report.reportNumber}</h1>
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {report.status === SERVICE_REPORT_STATUS.DRAFT
            ? "This report has not been submitted for the customer's signature yet. Open the report and choose “Submit for customer signature”."
            : "This report cannot be signed on this screen."}
        </p>
        <Link href={backHref} className="text-sm font-medium text-[var(--theme-accent)]">Back to the report</Link>
      </div>
    );
  }
  if (stage !== "done" && !report.permissions.canCollectSignature) {
    return (
      <div className="mx-auto max-w-xl space-y-3 p-6" data-testid="signing-no-access">
        <h1 className="text-xl font-semibold">{report.reportNumber}</h1>
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">Your account cannot collect the signature for this report.</p>
        <Link href={backHref} className="text-sm font-medium text-[var(--theme-accent)]">Back to the report</Link>
      </div>
    );
  }

  // ---- Step 1: addressed to the member of staff
  if (stage === "handoff") {
    return (
      <div className="mx-auto max-w-xl space-y-5 p-6" data-testid="signing-handoff">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">Step 1 of 2 · For Platino staff</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight" style={{ color: "var(--text-heading)" }}>Hand this device to the customer</h1>
          <p className="mt-1 text-sm text-gray-500">Report {report.reportNumber} · {report.customerName ?? "customer"}</p>
        </div>
        <ul className="list-disc space-y-1 rounded-xl border border-amber-200 bg-amber-50 p-4 pl-8 text-sm text-amber-900">
          <li>The customer must review the report and sign it <strong>personally</strong>.</li>
          <li>Do <strong>not</strong> type the customer&apos;s name, draw the signature or approve the report for them.</li>
          <li>Give the device to the customer first, then press the button below. The signing screen stays open for {SERVICE_REPORT_LIMITS.SIGNING_SESSION_MINUTES} minutes.</li>
        </ul>
        {error && <p role="alert" data-testid="signing-error-message" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
        <div className="flex flex-wrap items-center gap-4">
          <button onClick={startSigning} disabled={busy !== null} className="btn-primary px-5 py-3 text-sm font-semibold disabled:opacity-50" data-testid="start-signing">
            {busy === "start" ? "Starting…" : "The customer has the device – start signing"}
          </button>
          <Link href={backHref} className="text-sm font-medium text-gray-600 hover:underline">Back to the report</Link>
        </div>
      </div>
    );
  }

  // ---- Step 3: addressed to the member of staff again
  if (stage === "done") {
    return (
      <div className="mx-auto max-w-xl space-y-5 p-6" data-testid="signing-done">
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5 space-y-2">
          <h1 className="text-xl font-semibold text-emerald-800">Report signed and final</h1>
          <p className="text-sm text-emerald-900">
            Report {report.reportNumber} was signed by <strong>{report.signerName ?? "the customer"}</strong>
            {report.signedAt ? <> on {new Date(report.signedAt).toLocaleString()}</> : null}. The signed PDF has been saved and the report can no longer be changed.
          </p>
          <p className="text-sm text-emerald-900">You can take the device back now.</p>
        </div>
        {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
        <div className="flex flex-wrap gap-3">
          <button onClick={() => download(false)} disabled={busy !== null || !report.pdfAvailable} className="btn-primary px-4 py-2 text-sm disabled:opacity-50">
            {busy === "download" ? "Preparing…" : "Download signed PDF"}
          </button>
          <button onClick={() => download(true)} disabled={busy !== null || !report.pdfAvailable} className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-50">
            Open in a new tab
          </button>
        </div>
        <div className="flex flex-wrap gap-4 text-sm font-medium">
          <Link href={backHref} className="text-[var(--theme-accent)] hover:underline">Back to the report</Link>
          <Link href="/service-reports" className="text-[var(--theme-accent)] hover:underline">All service reports</Link>
        </div>
      </div>
    );
  }

  // ---- Step 2: addressed to the customer
  return (
    <div className="mx-auto max-w-2xl space-y-5 p-4 sm:p-6" data-testid="signing-customer">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Step 2 of 2 · For the customer</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight" style={{ color: "var(--text-heading)" }}>Please review and sign your service report</h1>
        <p className="mt-1 text-sm text-gray-500">Report {report.reportNumber}. Read it carefully, then sign at the bottom.</p>
      </div>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 rounded-xl border border-gray-200 bg-white p-4 text-sm sm:grid-cols-2" data-testid="signing-report-summary">
        {[
          ["Customer", report.customerName],
          report.kind === "amc" ? ["AMC order", report.amc?.ref ?? null] : report.kind === "direct" ? ["Report type", "Direct service report"] : ["Service ticket", report.ticketNumber],
          ["Site", [report.site?.name, report.site?.address].filter(Boolean).join(", ") || null],
          ["RECD serial number", report.unit?.serialNo ?? (report.kind === "direct" ? "Not recorded" : null)],
          ["RECD model", report.unit?.model ?? null],
          ["DG", [report.site?.dgModel, report.site?.dgCapacityKva ? `${report.site.dgCapacityKva} kVA` : null].filter(Boolean).join(", ") || null],
          ["Service visit date", report.visitDate],
          ["Engineer", report.engineer.name],
        ].map(([label, value]) => (
          <div key={label as string}>
            <dt className="text-xs text-gray-500">{label}</dt>
            <dd className="font-medium text-gray-800">{value || "-"}</dd>
          </div>
        ))}
      </dl>

      {([
        ["Work performed", report.workPerformed],
        ["Findings / observations", report.findings],
        ["Resolution / outcome", report.resolution],
        ...(report.partsUsed ? [["Parts used", report.partsUsed]] : []),
        ...(report.remarks ? [["Remarks", report.remarks]] : []),
      ] as Array<[string, string]>).map(([label, text]) => (
        <section key={label} className="space-y-1">
          <h2 className="text-sm font-semibold">{label}</h2>
          <p className="whitespace-pre-wrap rounded-lg bg-gray-50 p-3 text-sm text-gray-700">{text || "-"}</p>
        </section>
      ))}

      <section className="space-y-3 rounded-xl border border-gray-200 bg-white p-4" data-testid="sign-section">
        <h2 className="text-base font-semibold">Review and sign</h2>
        <p className="text-sm text-gray-600">By signing you confirm that the work and findings described above are correct. A signed report is final and cannot be changed.</p>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500" htmlFor="signer-name">Your full name</label>
          <input
            id="signer-name"
            className="field w-full"
            autoComplete="off"
            maxLength={SERVICE_REPORT_LIMITS.SIGNER_NAME_MAX}
            value={signerName}
            onChange={(e) => setSignerName(e.target.value)}
            disabled={busy === "sign"}
            data-testid="signer-name"
          />
          <p className="mt-1 text-[11px] text-gray-400">Type your own name. It will be printed on the signed report.</p>
        </div>
        <SignaturePad onChange={setSignatureImage} disabled={busy === "sign"} />
        <label className="flex items-start gap-2 text-sm text-gray-700">
          <input type="checkbox" className="mt-1" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} data-testid="confirm-approve" />
          <span>I have reviewed this report and approve it.</span>
        </label>
        {error && <p role="alert" data-testid="signing-error-message" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
        <button onClick={signNow} disabled={!canSignNow} className="btn-primary px-5 py-3 text-sm font-semibold disabled:opacity-50" data-testid="sign-and-finalise">
          {busy === "sign" ? "Signing…" : "Sign and finalise"}
        </button>
      </section>

      <p className="text-center text-[11px] text-gray-400">
        <button type="button" className="underline" onClick={() => backToHandoff("Signing was cancelled. Nothing was saved.")} data-testid="cancel-signing">Platino staff: cancel this signing</button>
      </p>
    </div>
  );
}
