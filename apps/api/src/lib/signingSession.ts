import { createHmac, timingSafeEqual } from "crypto";
import { SERVICE_REPORT_LIMITS } from "@recd/shared";

/**
 * The in-person signing session of a service report.
 *
 * A report is signed on the STAFF device, in front of the customer. Before the signing screen shows its form, the member of staff confirms that the
 * device is now with the customer (POST /service-reports/:id/signing-session); the server then hands out this short-lived token. A signature is
 * accepted only together with a token that is
 *   - issued for exactly THIS report and the VERSION the customer was shown (an edited report invalidates it),
 *   - issued to the SAME logged-in staff account that presents it,
 *   - not older than SERVICE_REPORT_LIMITS.SIGNING_SESSION_MINUTES.
 *
 * What this does and does not prove: it forces the explicit hand-over step, ties the signature to one report version and one device session,
 * and leaves an audit record of who started it. It cannot prove WHO is holding the pen - nothing on a shared device can; that stays a procedure
 * (the screen tells the member of staff to hand the device over and not to sign).
 *
 * It is NOT a login token: it is an HMAC under a key derived from JWT_SECRET for this purpose only, so it can never be presented as a Bearer token,
 * and a Bearer token can never be presented as a signing session.
 */
const PURPOSE = "service-report-in-person-signing-v1";

export interface SigningSessionClaims {
  reportId: string;
  version: number;
  /** The staff user whose device the customer is signing on. */
  staffId: string;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const key = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set");
  return createHmac("sha256", secret).update(PURPOSE).digest();
};
const mac = (payload: string) => createHmac("sha256", key()).update(payload).digest();

export const SIGNING_SESSION_TTL_MS = SERVICE_REPORT_LIMITS.SIGNING_SESSION_MINUTES * 60 * 1000;

export function issueSigningSession(claims: SigningSessionClaims, now = Date.now()): { token: string; expiresAt: Date } {
  const expiresAt = now + SIGNING_SESSION_TTL_MS;
  const payload = b64(JSON.stringify({ p: PURPOSE, r: claims.reportId, v: claims.version, s: claims.staffId, e: expiresAt }));
  return { token: `${payload}.${b64(mac(payload))}`, expiresAt: new Date(expiresAt) };
}

export type SigningSessionCheck = { ok: true } | { ok: false; reason: "malformed" | "forged" | "expired" | "other_report" | "other_version" | "other_user" };

export function checkSigningSession(token: string, expected: SigningSessionClaims, now = Date.now()): SigningSessionCheck {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  let given: Buffer;
  try {
    given = Buffer.from(parts[1], "base64url");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const wanted = mac(parts[0]);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return { ok: false, reason: "forged" };
  let data: { p?: unknown; r?: unknown; v?: unknown; s?: unknown; e?: unknown };
  try {
    data = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (data.p !== PURPOSE || typeof data.e !== "number") return { ok: false, reason: "malformed" };
  if (now > data.e) return { ok: false, reason: "expired" };
  if (data.r !== expected.reportId) return { ok: false, reason: "other_report" };
  if (data.v !== expected.version) return { ok: false, reason: "other_version" };
  if (data.s !== expected.staffId) return { ok: false, reason: "other_user" };
  return { ok: true };
}
