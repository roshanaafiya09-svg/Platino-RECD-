/**
 * A signed-in CUSTOMER may open the customer portal and nothing else: service reports are no longer reviewed or signed through a customer login.
 * The customer signs IN PERSON on a staff device, on the full-screen signing page below.
 */

/**
 * The in-person signing screen (/service-reports/<id>/sign). It is a staff page (the staff login that handed the device over stays signed in), but it
 * is shown without the application menu, so a customer holding the device sees only the report and the signing form.
 */
export function isInPersonSigningPath(pathname: string): boolean {
  return /^\/service-reports\/[^/]+\/sign\/?$/.test(pathname);
}

/** Permissions that open the staff service-report list (any one is enough). The API still decides which reports a user may see. */
export const SERVICE_REPORT_LIST_PERMISSIONS = ["manage_complaints", "view_complaints_overview", "act_assigned_complaints", "manage_amc_orders"] as const;

/** True when the signed-in staff user holds any permission that opens the service-report list (used to offer the "Service reports" links on the Customer and Site pages). */
export function canOpenServiceReports(hasPermission: (key: string) => boolean): boolean {
  return SERVICE_REPORT_LIST_PERMISSIONS.some((p) => hasPermission(p));
}
