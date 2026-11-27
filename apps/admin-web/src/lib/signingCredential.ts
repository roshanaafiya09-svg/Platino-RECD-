/**
 * The SIGNING CREDENTIAL of the in-person signing (customer step), kept on this device only for the life of this browser tab.
 *
 * What it is: when staff hand the device to the customer, the server issues a credential that can read and sign THIS ONE report (and cancel its signing)
 * for a few minutes - and nothing else (see apps/api/src/middleware/signingCredential.ts). The customer step uses it INSTEAD of the staff login: at that
 * moment the staff login token is removed from this device (releaseStaffLogin) and is never stored here again until staff sign in again.
 *
 * Where it lives: sessionStorage (this tab only; gone when the tab closes), so a reload of the signing page can resume the customer step. The staff
 * login token is never put there. If the browser refuses storage, the credential simply does not survive a reload.
 */
import { clearToken } from "@/lib/apiClient";

const KEY = "recd_signing_credential";
const RETURN_KEY = "recd_after_login";
/** Fired when the staff login has been taken off the device without going to the sign-in page, so the session screens drop the signed-in user. */
export const STAFF_RELEASED_EVENT = "recd-staff-released";

export interface StoredSigningCredential {
  reportId: string;
  token: string;
  /** ISO time the server gave: the credential stops working then (the server enforces it; this only lets the screen say so). */
  expiresAt: string;
  version: number;
}

function store(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export function saveSigningCredential(c: StoredSigningCredential): void {
  try {
    store()?.setItem(KEY, JSON.stringify(c));
  } catch {
    // storage refused: the customer step still works, it just cannot resume after a reload
  }
}

export function clearSigningCredential(): void {
  try {
    store()?.removeItem(KEY);
  } catch {
    // nothing to clear
  }
}

/** The stored credential for this report, if there is one that has not run out. An unreadable, foreign or expired one is removed. */
export function readSigningCredential(reportId: string, now = Date.now()): StoredSigningCredential | null {
  let raw: string | null = null;
  try {
    raw = store()?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as Partial<StoredSigningCredential>;
    if (typeof c.reportId === "string" && typeof c.token === "string" && typeof c.expiresAt === "string" && typeof c.version === "number" && c.reportId === reportId && Date.parse(c.expiresAt) > now) {
      return c as StoredSigningCredential;
    }
  } catch {
    // fall through: remove it
  }
  clearSigningCredential();
  return null;
}

const SIGN_PATH = /^\/service-reports\/([^/]+)\/sign\/?$/;

/** The report id of an in-person signing address, or null. */
export function signingReportIdFromPath(pathname: string): string | null {
  const m = SIGN_PATH.exec(pathname);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Is this the signing screen of a report for which this tab holds a live credential (so it may be shown without a staff login)? */
export function hasCredentialForPath(pathname: string, now = Date.now()): boolean {
  const id = signingReportIdFromPath(pathname);
  return !!id && readSigningCredential(id, now) !== null;
}

/**
 * Takes the staff login off this device: the token is removed from storage and the signed-in user is dropped, with no redirect (the customer step stays on
 * screen). The server-side login is not revoked (staff may be signed in on other devices); it is simply no longer here.
 */
export function releaseStaffLogin(): void {
  clearToken();
  try {
    window.localStorage.removeItem("recd_customer_ord");
  } catch {
    // nothing to remove
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(STAFF_RELEASED_EVENT));
}

/** Where to send staff after they sign in again (set by the signing screen, used once by the sign-in redirect). Only report pages are accepted. */
export function setAfterLoginPath(path: string): void {
  if (isAllowedReturnPath(path)) {
    try {
      store()?.setItem(RETURN_KEY, path);
    } catch {
      // no return path: staff land on their usual first page
    }
  }
}

export function takeAfterLoginPath(): string | null {
  let path: string | null = null;
  try {
    path = store()?.getItem(RETURN_KEY) ?? null;
    store()?.removeItem(RETURN_KEY);
  } catch {
    return null;
  }
  return path && isAllowedReturnPath(path) ? path : null;
}

export function isAllowedReturnPath(path: string): boolean {
  return /^\/service-reports\/[A-Za-z0-9_-]+$/.test(path);
}
