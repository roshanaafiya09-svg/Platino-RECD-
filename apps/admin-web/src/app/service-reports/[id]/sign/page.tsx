"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { SERVICE_REPORT_LIMITS, SERVICE_REPORT_STATUS, type ServiceReportStatus } from "@recd/shared";
import { api, apiWithSigningCredential, ApiRequestError } from "@/lib/apiClient";
import { clearSigningCredential, readSigningCredential, releaseStaffLogin, saveSigningCredential, setAfterLoginPath, type StoredSigningCredential } from "@/lib/signingCredential";
import { apiErrorMessage } from "@/lib/apiError";
import SignaturePad from "@/components/SignaturePad";
import { downloadReportPdf, openReportPdf, withPdfFallbackHint } from "@/lib/reportFiles";
import SharePdfButton from "@/components/SharePdfButton";

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

type Stage = "handoff" | "customer" | "done" | "ended";

/** What GET /service-reports/:id/signing-view returns to the customer step: only what the customer is shown. */
interface SigningView {
  id: string;
  reportNumber: string;
  kind: "ticket" | "amc" | "direct";
  ticketNumber: string | null;
  amc: { ref: string } | null;
  status: ServiceReportStatus;
  version: number;
  visitDate: string;
  workPerformed: string;
  findings: string;
  resolution: string;
  partsUsed: string | null;
  remarks: string | null;
  engineer: { name: string };
  customerName: string | null;
  site: ReportDetail["site"];
  unit: ReportDetail["unit"];
}

/** The customer step shows the same screen from the smaller view: the fields it does not get are simply empty. */
function reportFromSigningView(v: SigningView): ReportDetail {
  return {
    id: v.id, reportNumber: v.reportNumber, kind: v.kind, complaintId: null, ticketNumber: v.ticketNumber,
    amc: v.amc ? { id: "", ref: v.amc.ref, poNo: "", type: "", typeLabel: "" } : null,
    status: v.status, version: v.version, visitDate: v.visitDate, workPerformed: v.workPerformed, findings: v.findings, resolution: v.resolution,
    partsUsed: v.partsUsed, remarks: v.remarks, engineer: { id: "", name: v.engineer.name }, signedAt: null, signerName: null, pdfAvailable: false,
    customerName: v.customerName, site: v.site, unit: v.unit, permissions: { canCollectSignature: true },
  };
}

const SESSION_ENDED = "This signing session has ended. Nothing was saved.";
// What the server says when the credential is no longer good (ended, cancelled, replaced, expired, report changed): the customer step cannot continue.
const ENDING_CODES = ["SIGNING_SESSION_INVALID", "STALE_VERSION", "ALREADY_SIGNED", "REPORT_NOT_SIGNABLE", "BAD_TRANSITION"];

/**
 * IN-PERSON SIGNING (/service-reports/<id>/sign). The page a member of staff lands on right after "Submit for customer signature", and the one
 * "Open the customer signing screen" returns to. It is shown full screen, without the application menu, and has three steps on ONE device:
 *   1. handoff  - addressed to STAFF: give the device to the customer, who signs personally; staff never draw, type or approve for them.
 *                 Pressing the button tells the server the device is with the customer and starts a short signing session.
 *   2. customer - addressed to the CUSTOMER: review the report, type YOUR OWN name (the box starts empty), draw YOUR signature, tick the approval.
 *   3. done     - addressed to STAFF again: the confirmation, the signed PDF and the way back.
 * The server re-checks everything (the signing session, the report version, the signature image, that the signer is not the staff member).
 *
 * THE STAFF LOGIN IS NOT ON THE DEVICE DURING STEP 2. Pressing the hand-over button asks the server for a SIGNING CREDENTIAL that can read and sign this one
 * report (and cancel its signing) for a few minutes and nothing else; the staff login token is then removed from this device (lib/signingCredential.ts).
 * Step 2 and the confirmation use only the credential, which this tab keeps in sessionStorage so a reload resumes the customer step. When the signing is
 * finished, cancelled or has run out, staff sign in again (password or Google) to continue; the sign-in returns them to the report.
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
  const [credential, setCredential] = useState<StoredSigningCredential | null>(null); // set while the customer step runs on a signing credential
  const [viaCredential, setViaCredential] = useState(false); // this device is (or was) in the customer step without a staff login
  const [endedMessage, setEndedMessage] = useState<string | null>(null);

  /** The customer step is over (cancelled, finished badly, expired, replaced): forget everything about it. Staff sign in again to carry on. */
  const endCustomerStep = useCallback((message: string) => {
    clearSigningCredential();
    setCredential(null);
    setSession(null);
    setSignerName("");
    setSignatureImage(null);
    setConfirm(false);
    setError(null);
    setEndedMessage(message);
    setStage("ended");
  }, []);

  const loadCustomerView = useCallback(
    async (c: StoredSigningCredential) => {
      try {
        const v = await apiWithSigningCredential<SigningView>(`/service-reports/${c.reportId}/signing-view`, c.token);
        setReport(reportFromSigningView(v));
        setCredential(c);
        setViaCredential(true);
        setLoadError(null);
        setStage("customer");
      } catch (err) {
        const notWaiting = err instanceof ApiRequestError && err.status === 409;
        endCustomerStep(notWaiting ? "This report is no longer waiting for a signature." : SESSION_ENDED);
      }
    },
    [endCustomerStep],
  );

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

  // A reload of this page during the customer step resumes it from the credential this tab kept; otherwise this is a normal staff visit.
  useEffect(() => {
    const stored = readSigningCredential(id);
    if (stored) void loadCustomerView(stored);
    else void load();
  }, [id, load, loadCustomerView]);

  // The credential runs out after a few minutes (the server enforces it): end the customer step on screen at that moment too.
  useEffect(() => {
    if (!credential || stage !== "customer") return;
    const t = setTimeout(() => endCustomerStep(SESSION_ENDED), Math.max(0, Date.parse(credential.expiresAt) - Date.now()));
    return () => clearTimeout(t);
  }, [credential, stage, endCustomerStep]);

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
      const r = await api<{ signingSession: string; signingCredential?: string; expiresAt?: string; version?: number }>(`/service-reports/${id}/signing-session`, {
        method: "POST",
        body: JSON.stringify({ expectedVersion: report.version, handoffConfirmed: true }),
      });
      if (r.signingCredential && r.expiresAt) {
        // From here the customer step uses ONLY the signing credential: keep it for this tab, then take the staff login off the device.
        const c: StoredSigningCredential = { reportId: id, token: r.signingCredential, expiresAt: r.expiresAt, version: r.version ?? report.version };
        saveSigningCredential(c);
        releaseStaffLogin();
        await loadCustomerView(c);
      } else {
        // An API without signing credentials (not expected): the earlier flow, with the staff login.
        setSession(r.signingSession);
        setStage("customer");
      }
    } catch (err) {
      setError(apiErrorMessage(err, "The signing could not be started."));
      if (err instanceof ApiRequestError && (err.body.code === "STALE_VERSION" || err.body.code === "BAD_TRANSITION" || err.body.code === "REPORT_NOT_SIGNABLE")) load();
    } finally {
      setBusy(null);
    }
  }

  async function signNow() {
    if (!report || (!session && !credential) || !signatureImage) return;
    setBusy("sign");
    setError(null);
    if (credential) {
      // Customer step: only the signing credential is used (no staff login on this device).
      try {
        const done = await apiWithSigningCredential<{ signedAt: string | null; signerName: string | null }>(`/service-reports/${id}/sign`, credential.token, {
          method: "POST",
          body: JSON.stringify({ signerName, signatureImage, version: report.version, confirm: true, signingSession: credential.token }),
        });
        clearSigningCredential();
        setCredential(null);
        setSignatureImage(null);
        setReport({ ...report, status: SERVICE_REPORT_STATUS.SIGNED, signedAt: done.signedAt, signerName: done.signerName });
        setStage("done");
      } catch (err) {
        const code = err instanceof ApiRequestError ? (err.body.code as string | undefined) : undefined;
        const text = apiErrorMessage(err, "The report could not be signed. Nothing was saved.");
        if ((err instanceof ApiRequestError && err.status === 401) || (code && ENDING_CODES.includes(code))) endCustomerStep(text);
        else setError(text); // e.g. a name that is not the customer's, or a signature that is too small: the customer can correct it and try again
      } finally {
        setBusy(null);
      }
      return;
    }
    try {
      await api(`/service-reports/${id}/sign`, {
        method: "POST",
        body: JSON.stringify({ signerName, signatureImage, version: report.version, confirm: true, signingSession: session }),
      }); // (staff-login path, kept for an API without signing credentials)
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

  /** Cancel: the credential is ended at the server at once, then forgotten here. Staff sign in again to carry on. */
  async function cancelSigning() {
    if (credential) {
      try {
        await apiWithSigningCredential(`/service-reports/${id}/signing-session/cancel`, credential.token, { method: "POST", body: "{}" });
      } catch {
        // already ended or unreachable: the credential is dropped from this device either way and expires on its own
      }
      endCustomerStep("Signing was cancelled. Nothing was saved.");
      return;
    }
    backToHandoff("Signing was cancelled. Nothing was saved.");
  }

  async function download(open: boolean) {
    if (!report) return;
    setBusy("download");
    setError(null);
    try {
      if (open) await openReportPdf(report.id, report.reportNumber);
      else await downloadReportPdf(report.id, report.reportNumber);
    } catch (err) {
      setError(withPdfFallbackHint(apiErrorMessage(err, "The signed report could not be downloaded.")));
    } finally {
      setBusy(null);
    }
  }

  const backHref = report ? `/service-reports/${report.id}` : "/service-reports";

  const staffSignIn = (
    <Link
      href="/login"
      onClick={() => setAfterLoginPath(`/service-reports/${id}`)}
      className="btn-primary inline-flex min-h-[44px] items-center px-5 text-sm font-semibold"
      data-testid="staff-sign-in"
    >
      Platino staff: sign in to continue
    </Link>
  );

  // ---- The customer step is over without a signature (cancelled, expired, replaced, or the report changed)
  if (stage === "ended") {
    return (
      <div className="mx-auto max-w-xl space-y-5 p-6" data-testid="signing-ended">
        <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-5">
          <h1 className="text-xl font-semibold text-amber-900">This signing screen has closed</h1>
          <p className="text-sm text-amber-900" data-testid="signing-ended-message">{endedMessage}</p>
          <p className="text-sm text-amber-900">Please hand the device back to Platino staff.</p>
        </div>
        {staffSignIn}
      </div>
    );
  }

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
  // Shown above the phone Sign bar: the next thing the customer still has to do.
  const signHint =
    signerName.trim().length < SERVICE_REPORT_LIMITS.SIGNER_NAME_MIN ? "Type your full name"
    : !signatureImage ? "Draw your signature in the box"
    : !confirm ? "Tick the approval box"
    : "Ready to sign";

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
          <Link href={backHref} className="inline-flex min-h-[44px] items-center text-sm font-medium text-gray-600 hover:underline md:min-h-0">Back to the report</Link>
        </div>
      </div>
    );
  }

  // ---- Step 3 after a customer-step signing: no staff login is on this device, so there is nothing to download here - staff sign in again first
  if (stage === "done" && viaCredential) {
    return (
      <div className="mx-auto max-w-xl space-y-5 p-6" data-testid="signing-done">
        <div className="space-y-2 rounded-xl border border-emerald-200 bg-emerald-50 p-5">
          <h1 className="text-xl font-semibold text-emerald-800">Report signed and final</h1>
          <p className="text-sm text-emerald-900">
            Report {report.reportNumber} was signed by <strong>{report.signerName ?? "the customer"}</strong>
            {report.signedAt ? <> on {new Date(report.signedAt).toLocaleString()}</> : null}. The signed PDF has been saved and the report can no longer be changed.
          </p>
          <p className="text-sm text-emerald-900">Thank you. Please hand the device back to Platino staff.</p>
        </div>
        <div className="space-y-2">
          <p className="text-xs text-gray-500">The signed PDF is available to Platino staff after they sign in.</p>
          {staffSignIn}
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
          <button onClick={() => download(false)} disabled={busy !== null || !report.pdfAvailable} className="btn-primary px-4 py-3 text-sm disabled:opacity-50 md:py-2">
            {busy === "download" ? "Preparing…" : "Download signed PDF"}
          </button>
          <button onClick={() => download(true)} disabled={busy !== null || !report.pdfAvailable} className="rounded-lg border border-gray-300 bg-white px-4 py-3 text-sm font-medium text-gray-700 disabled:opacity-50 md:py-2">
            Open in a new tab
          </button>
          <SharePdfButton reportId={report.id} reportNumber={report.reportNumber} disabled={busy !== null || !report.pdfAvailable} className="rounded-lg border border-gray-300 bg-white px-4 py-3 text-sm font-medium text-gray-700 disabled:opacity-50" />
        </div>
        <div className="flex flex-wrap gap-4 text-sm font-medium">
          <Link href={backHref} className="inline-flex min-h-[44px] items-center text-[var(--theme-accent)] hover:underline md:min-h-0">Back to the report</Link>
          <Link href="/service-reports" className="inline-flex min-h-[44px] items-center text-[var(--theme-accent)] hover:underline md:min-h-0">All service reports</Link>
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
        <label className="flex min-h-[44px] items-start gap-2 text-sm text-gray-700 md:min-h-0">
          <input type="checkbox" className="mt-1 h-6 w-6 shrink-0 md:h-auto md:w-auto" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} data-testid="confirm-approve" />
          <span>I have reviewed this report and approve it.</span>
        </label>
        {error && <p role="alert" data-testid="signing-error-message" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
        <button onClick={signNow} disabled={!canSignNow} className="btn-primary hidden px-5 py-3 text-sm font-semibold disabled:opacity-50 md:inline-block" data-testid="sign-and-finalise">
          {busy === "sign" ? "Signing…" : "Sign and finalise"}
        </button>
      </section>

      <p className="text-center text-[11px] text-gray-400">
        <button type="button" className="inline-flex min-h-[44px] items-center px-4 underline md:min-h-0 md:px-0" onClick={cancelSigning} data-testid="cancel-signing">Platino staff: cancel this signing</button>
      </p>

      {/* Phones (below 768px): the Sign action stays at the bottom of the screen while the report is read and signed. It sits in the page flow
          (sticky, not fixed), so it never covers the report or the form, and it does the same thing as the button above (same rule to enable it). */}
      <div
        className="sticky bottom-0 z-10 -mx-4 border-t border-gray-200 bg-white/95 px-4 pt-3 backdrop-blur sm:-mx-6 sm:px-6 md:hidden"
        style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
        data-testid="sign-bar-mobile"
      >
        <p className="mb-2 text-center text-[11px] text-gray-500" aria-live="polite" data-testid="sign-bar-hint">{signHint}</p>
        <button onClick={signNow} disabled={!canSignNow} className="btn-primary min-h-[48px] w-full px-5 text-sm font-semibold disabled:opacity-50" data-testid="sign-and-finalise-mobile">
          {busy === "sign" ? "Signing…" : "Sign and finalise"}
        </button>
      </div>
    </div>
  );
}
