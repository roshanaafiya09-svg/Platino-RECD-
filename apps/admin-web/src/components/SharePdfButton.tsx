"use client";

import { useEffect, useRef, useState } from "react";
import { apiErrorMessage } from "@/lib/apiError";
import { canSharePdfFiles, fetchReportPdfFile, shareFailureText, sharePdfFile } from "@/lib/reportFiles";

interface Props {
  reportId: string;
  reportNumber: string;
  /** Classes for the button itself (the component adds `md:hidden`: sharing is offered on phones only). */
  className?: string;
  label?: string;
  disabled?: boolean;
  /** Extra classes for the wrapper (for example `flex-1` inside a button row). */
  wrapperClassName?: string;
}

/**
 * "Share PDF" for phones: downloads the report PDF with the signed-in user's own login (so the server checks access every time) and hands the
 * file to the phone's share sheet (WhatsApp, Mail, Drive, Files...). No link is created and nothing is stored: if sharing is not available in this
 * browser the button is simply not shown and the Download / Open buttons remain. Hidden from 768px up, where laptops and desktops keep their usual buttons.
 */
export default function SharePdfButton({ reportId, reportNumber, className = "", label = "Share PDF", disabled = false, wrapperClassName = "" }: Props) {
  const [supported, setSupported] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const ready = useRef<File | null>(null); // a PDF already downloaded for this button, only kept while the "tap again" prompt is showing

  useEffect(() => setSupported(canSharePdfFiles()), []);
  useEffect(() => {
    ready.current = null;
    setNotice(null);
  }, [reportId]);

  if (!supported) return null;

  async function share() {
    setNotice(null);
    setBusy(true);
    try {
      const file = ready.current ?? (await fetchReportPdfFile(reportId, reportNumber));
      ready.current = null;
      const outcome = await sharePdfFile(file, `Service report ${reportNumber}`);
      if (outcome === "needs-tap") {
        ready.current = file;
        setNotice({ kind: "info", text: "The PDF is ready. Tap Share PDF again to choose where to send it." });
      } else if (outcome === "unsupported") {
        setNotice({ kind: "error", text: "This phone cannot share the file from here. Use Download signed PDF instead." });
      }
    } catch (err) {
      setNotice({ kind: "error", text: shareFailureText(err, apiErrorMessage(err, "The report could not be prepared for sharing.")) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`md:hidden ${wrapperClassName}`} data-testid="share-pdf">
      <button type="button" onClick={share} disabled={busy || disabled} className={className} data-testid="share-pdf-button">
        {busy ? "Preparing…" : label}
      </button>
      {notice && (
        <p role={notice.kind === "error" ? "alert" : "status"} className={`mt-2 text-xs ${notice.kind === "error" ? "text-red-600" : "text-gray-600"}`} data-testid="share-pdf-notice">
          {notice.text}
        </p>
      )}
    </div>
  );
}
