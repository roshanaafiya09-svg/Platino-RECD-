import { createHmac, randomBytes, timingSafeEqual } from "crypto";
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
const key = (purpose: string = PURPOSE) => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set");
  return createHmac("sha256", secret).update(purpose).digest();
};
const mac = (payload: string, purpose: string = PURPOSE) => createHmac("sha256", key(purpose)).update(payload).digest();

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

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The SIGNING CREDENTIAL (customer step of the in-person signing).
//
// The session above proves that the staff device was handed over. The credential below is what the CUSTOMER STEP of the signing screen then uses
// INSTEAD of the staff login, so the staff login token never has to be on the device while the customer holds it. It is the same kind of object
// (an HMAC token, never a Bearer login) with its own purpose key, so neither can be presented as the other, and it can do exactly three things for
// exactly ONE report (see middleware/signingCredential.ts): read the signing view, sign, cancel.
//
// Beyond what the session proves it also carries
//   - a random session id: only the NEWEST signing started for the report is live, and a cancel ends exactly that one (both are recorded as audit
//     events, so no database column is needed), and
//   - the staff account's token version: a password reset / change, deactivation or role change ends the credential at once.
// The server re-checks the staff account (active, same token version, no forced password change, still allowed to collect this signature) on EVERY use.
// ---------------------------------------------------------------------------------------------------------------------------------------------
const CREDENTIAL_PURPOSE = "service-report-signing-credential-v1";

export interface SigningCredentialClaims {
  reportId: string;
  version: number;
  staffId: string;
  /** The staff account's tokenVersion when the credential was issued (null counts as 0, as for login tokens). */
  tokenVersion: number;
  /** Random id of this signing session; written into the "signing started" audit event. */
  sessionId: string;
}

export const newSigningSessionId = () => randomBytes(18).toString("base64url");

export function issueSigningCredential(claims: SigningCredentialClaims, now = Date.now()): { token: string; expiresAt: Date } {
  const expiresAt = now + SIGNING_SESSION_TTL_MS;
  const payload = b64(JSON.stringify({ p: CREDENTIAL_PURPOSE, r: claims.reportId, v: claims.version, s: claims.staffId, t: claims.tokenVersion, n: claims.sessionId, e: expiresAt }));
  return { token: `${payload}.${b64(mac(payload, CREDENTIAL_PURPOSE))}`, expiresAt: new Date(expiresAt) };
}

export type SigningCredentialParse =
  | { ok: true; claims: SigningCredentialClaims; expiresAt: Date }
  | { ok: false; reason: "malformed" | "forged" | "expired" };

/** Checks the signature, the purpose and the expiry only. Whether the session is still the live one, and the staff account, are checked against the database by the caller. */
export function parseSigningCredential(token: string, now = Date.now()): SigningCredentialParse {
  const parts = typeof token === "string" && token.length < 2000 ? token.split(".") : [];
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  let given: Buffer;
  try {
    given = Buffer.from(parts[1], "base64url");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const wanted = mac(parts[0], CREDENTIAL_PURPOSE);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return { ok: false, reason: "forged" };
  let d: { p?: unknown; r?: unknown; v?: unknown; s?: unknown; t?: unknown; n?: unknown; e?: unknown };
  try {
    d = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (d.p !== CREDENTIAL_PURPOSE || typeof d.r !== "string" || typeof d.v !== "number" || typeof d.s !== "string" || typeof d.t !== "number" || typeof d.n !== "string" || typeof d.e !== "number") {
    return { ok: false, reason: "malformed" };
  }
  if (now > d.e) return { ok: false, reason: "expired" };
  return { ok: true, claims: { reportId: d.r, version: d.v, staffId: d.s, tokenVersion: d.t, sessionId: d.n }, expiresAt: new Date(d.e) };
}
