import type { NextFunction, Response } from "express";
import { COMPLAINT_EVENT } from "@recd/shared";
import { prisma } from "../lib/prisma";
import { parseSigningCredential, type SigningCredentialClaims } from "../lib/signingSession";
import { authLookup, type AuthenticatedRequest } from "./auth";

/**
 * The SIGNING CREDENTIAL gate (customer step of the in-person signing; see lib/signingSession.ts).
 *
 * A request that carries `Authorization: Signing <credential>` is handled HERE, before anything else in the service-report router, and nowhere else:
 *   1. SCOPE - only the three approved requests below, for the report named in the credential. Everything else is refused with 403 before the
 *      credential is even looked at (so a refusal never tells a caller whether a credential was valid).
 *   2. VALIDITY - genuine signature, own purpose key, not expired; then, against the database: it is still the NEWEST signing started for this
 *      report and has not been cancelled, and the staff account that started it is still active, has the same token version, is not forced to change its
 *      password. (Whether that account may still collect THIS report's signature, the report's status and version, are checked by the route handlers
 *      with the same access rules as the staff flow.)
 *   3. IDENTITY - req.auth becomes that staff account (so every rule and audit entry downstream is exactly the staff flow's); req.signing carries the credential.
 *
 * Every other router authenticates with `authenticate`, which accepts only `Bearer <login token>`: the "Signing" scheme is not a Bearer login, so every
 * other route answers it exactly like a request with no login at all. The public routes (sign-in, public complaint form, health) are public for everyone.
 */
export const SIGNING_SCHEME = "Signing ";
export const SIGNING_STARTED_EVENT = "service_report_signing_started";
export const SIGNING_CANCELLED_EVENT = "service_report_signing_cancelled";

/** The ONLY requests a signing credential may make, relative to the /service-reports mount. */
export const SIGNING_CREDENTIAL_ROUTES = [
  { method: "GET", pattern: /^\/([^/]+)\/signing-view$/, name: "signing-view" },
  { method: "POST", pattern: /^\/([^/]+)\/sign$/, name: "sign" },
  { method: "POST", pattern: /^\/([^/]+)\/signing-session\/cancel$/, name: "cancel" },
] as const;

export interface SigningRequest extends AuthenticatedRequest {
  signing?: { token: string; claims: SigningCredentialClaims; expiresAt: Date };
}

export const SIGNING_SCOPE_ERROR = { error: "This signing credential cannot be used for this request.", code: "SIGNING_CREDENTIAL_SCOPE" };
export const SIGNING_INVALID_ERROR = {
  error: "This signing session has ended. Please hand the device back to Platino staff.",
  code: "SIGNING_SESSION_INVALID",
};

/** Is the signing session with this id still the live one for the report (the newest event is its start: not cancelled, not superseded by a newer start, not signed)? */
export async function isLiveSigningSession(reportId: string, sessionId: string): Promise<boolean> {
  const latest = await prisma.serviceReportEvent.findFirst({
    where: { reportId, type: { in: [SIGNING_STARTED_EVENT, SIGNING_CANCELLED_EVENT, COMPLAINT_EVENT.SERVICE_REPORT_SIGNED] } }, // started = live; cancelled or signed (newer) = over
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { type: true, detail: true },
  });
  if (!latest || latest.type !== SIGNING_STARTED_EVENT) return false;
  const detail = latest.detail as { sessionId?: unknown } | null;
  return !!detail && typeof detail.sessionId === "string" && detail.sessionId === sessionId;
}

export async function signingCredentialGate(req: SigningRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith(SIGNING_SCHEME)) return next(); // not a signing credential: the normal login rules apply

  // 1. scope
  const route = SIGNING_CREDENTIAL_ROUTES.find((r) => r.method === req.method && r.pattern.test(req.path));
  if (!route) return res.status(403).json(SIGNING_SCOPE_ERROR);
  let urlReportId: string;
  try {
    urlReportId = decodeURIComponent(route.pattern.exec(req.path)![1]);
  } catch {
    return res.status(403).json(SIGNING_SCOPE_ERROR);
  }

  // 2. validity of the credential itself
  const token = header.slice(SIGNING_SCHEME.length).trim();
  const parsed = parseSigningCredential(token);
  if (!parsed.ok) return res.status(401).json(SIGNING_INVALID_ERROR);
  const { claims } = parsed;
  if (claims.reportId !== urlReportId) return res.status(403).json(SIGNING_SCOPE_ERROR);

  // 2b. still the live session, and the staff account behind it is still in good standing
  if (!(await isLiveSigningSession(claims.reportId, claims.sessionId))) return res.status(401).json(SIGNING_INVALID_ERROR);
  const user = await authLookup.load(claims.staffId);
  if (!user || !user.isActive || (user.tokenVersion ?? 0) !== claims.tokenVersion || user.mustChangePassword) {
    return res.status(401).json(SIGNING_INVALID_ERROR);
  }

  // 3. identity: the staff account that handed the device over
  req.auth = {
    userId: user.id,
    roleKey: user.roleKey,
    customerId: user.customerId,
    vendorId: user.vendorId,
    permissions: new Set(user.permissions),
  };
  req.signing = { token, claims, expiresAt: parsed.expiresAt };
  return next();
}
