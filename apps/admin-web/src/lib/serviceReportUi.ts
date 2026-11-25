import { SERVICE_REPORT_STATUS } from "@recd/shared";

/** The label of a report's kind, so direct, ticket and AMC reports read differently everywhere. */
export function reportKindLabel(kind: string): string {
  if (kind === "direct") return "Direct";
  if (kind === "amc") return "AMC";
  return "Ticket";
}

/** CSS class of the small kind badge (direct reports are the ones with no ticket or AMC order). */
export function reportKindPill(kind: string): string {
  return kind === "direct" ? "status-pill status-pill-warning" : "status-pill";
}

/** CSS class of the status pill for a service report. */
export function reportStatusPill(status: string): string {
  if (status === SERVICE_REPORT_STATUS.SIGNED) return "status-pill status-pill-success";
  if (status === SERVICE_REPORT_STATUS.AWAITING_SIGNATURE) return "status-pill status-pill-warning";
  // Final but NOT signed: deliberately not the green "signed" look.
  if (status === SERVICE_REPORT_STATUS.SUBMITTED) return "status-pill";
  return "status-pill";
}
