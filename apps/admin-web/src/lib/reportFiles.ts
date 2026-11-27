import { ApiRequestError, apiBlob } from "@/lib/apiClient";
import { PHONE_MEDIA_QUERY } from "@/lib/signaturePadSize";

/**
 * Signed / final report PDFs. Every function here fetches the file from GET /service-reports/:id/pdf WITH the signed-in user's login token, so the
 * server decides every time whether this person may see this report (nothing is cached, nothing is a link, nothing is public). Sharing hands the
 * downloaded file itself to the phone's share sheet; it never creates or shares a URL.
 */

/** Is this a phone-sized screen (below 768px)? Laptops and desktops keep the behaviour they always had. */
export function isPhoneScreen(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(PHONE_MEDIA_QUERY).matches;
}

/** Saves a signed report PDF through the browser's download flow, fetched with the login token. */
export async function downloadReportPdf(reportId: string, reportNumber: string): Promise<void> {
  const blob = await apiBlob(`/service-reports/${reportId}/pdf`);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `service-report-${reportNumber}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Opens the signed PDF in a new tab. The tab is opened first (inside the click) so pop-up blockers allow it.
 * If the browser refuses the new tab: laptops and desktops carry on as before (the PDF replaces this page); on a phone the person is
 * kept on the report and the PDF is downloaded instead, so they never lose the screen they were on.
 */
export async function openReportPdf(reportId: string, reportNumber?: string): Promise<void> {
  const tab = window.open("", "_blank");
  if (!tab && isPhoneScreen() && reportNumber) {
    await downloadReportPdf(reportId, reportNumber);
    return;
  }
  try {
    const blob = await apiBlob(`/service-reports/${reportId}/pdf?disposition=inline`);
    const url = URL.createObjectURL(blob);
    if (tab) tab.location.href = url;
    else window.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
  } catch (err) {
    tab?.close();
    throw err;
  }
}

export function reportPdfName(reportNumber: string): string {
  return `service-report-${reportNumber}.pdf`;
}

/** The part of the browser's navigator that sharing needs (a parameter so the logic can be tested without a browser). */
export interface ShareCapableNavigator {
  share?: (data: { files?: File[]; title?: string; text?: string }) => Promise<void>;
  canShare?: (data: { files?: File[] }) => boolean;
}

/** True when this browser can hand a PDF file to the system share sheet (iOS Safari, Android Chrome and similar). */
export function canSharePdfFiles(nav: ShareCapableNavigator | undefined = typeof navigator !== "undefined" ? (navigator as ShareCapableNavigator) : undefined): boolean {
  if (!nav || typeof nav.share !== "function" || typeof nav.canShare !== "function") return false;
  try {
    return nav.canShare({ files: [new File([new Uint8Array(1)], "probe.pdf", { type: "application/pdf" })] }) === true;
  } catch {
    return false;
  }
}

/** Downloads the PDF (authorised by the server for this signed-in user) as a File ready to share. Throws the server's error if access is refused. */
export async function fetchReportPdfFile(reportId: string, reportNumber: string): Promise<File> {
  const blob = await apiBlob(`/service-reports/${reportId}/pdf`);
  return new File([blob], reportPdfName(reportNumber), { type: "application/pdf" });
}

export type ShareOutcome = "shared" | "cancelled" | "needs-tap" | "unsupported";

/**
 * Opens the share sheet for an already-downloaded PDF.
 *  - "shared"      the person picked somewhere to send it
 *  - "cancelled"   they closed the sheet: not an error
 *  - "needs-tap"   the browser wanted a fresh tap (the download took long enough that the tap expired): share the same file again, no new download
 *  - "unsupported" this browser cannot share this file: offer download / open instead
 * Any other failure is thrown.
 */
export async function sharePdfFile(file: File, title: string, nav: ShareCapableNavigator | undefined = typeof navigator !== "undefined" ? (navigator as ShareCapableNavigator) : undefined): Promise<ShareOutcome> {
  if (!nav || typeof nav.share !== "function" || typeof nav.canShare !== "function" || !nav.canShare({ files: [file] })) return "unsupported";
  try {
    await nav.share({ files: [file], title });
    return "shared";
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "AbortError") return "cancelled";
    if (name === "NotAllowedError") return "needs-tap";
    if (name === "NotSupportedError" || name === "TypeError") return "unsupported";
    throw err;
  }
}

/** On a phone, adds a pointer to the other ways of getting the PDF after a failure; laptops and desktops get the message unchanged. */
export function withPdfFallbackHint(message: string): string {
  return isPhoneScreen() ? `${endSentence(message)} Check your connection and try again, or use Share or Download.` : message;
}

/**
 * What to tell the person when preparing a PDF for sharing failed. A refusal (not signed in, no access to this report, no such report) is said
 * plainly - "check your connection" would be wrong - and nothing was shared; anything else gets the retry / Download pointer.
 */
export function shareFailureText(err: unknown, serverMessage: string): string {
  const status = err instanceof ApiRequestError ? err.status : 0;
  if (status === 401) return "Your session has expired. Sign in again to share this report. Nothing was shared.";
  if (status === 403 || status === 404) return "You do not have access to this report's PDF. Nothing was shared.";
  return `${endSentence(serverMessage)} Check your connection and try again, or use Download.`;
}

/** Makes sure a message ends with a full stop (server messages do not always) before more text is added after it. */
export function endSentence(message: string): string {
  const m = message.trim();
  return /[.!?]$/.test(m) ? m : `${m}.`;
}
