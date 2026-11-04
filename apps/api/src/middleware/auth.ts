import type { Request, Response, NextFunction } from "express";
import { verifyToken } from "../lib/jwt";
import { prisma } from "../lib/prisma";

export interface AuthenticatedRequest extends Request {
  auth?: {
    userId: string;
    roleKey: string;
    customerId?: string | null;
    vendorId?: string | null;
    permissions: Set<string>;
  };
}

/** Machine-readable code the web and mobile apps recognise: the account must set a new password before it may use anything else. */
export const PASSWORD_CHANGE_REQUIRED = "PASSWORD_CHANGE_REQUIRED";

/**
 * Validates the bearer token and loads the CURRENT account (so activation, role and tokenVersion are never taken from the token alone).
 * An account flagged mustChangePassword is refused with 403 PASSWORD_CHANGE_REQUIRED on every route that uses `authenticate` - this is
 * the server-side boundary; the web AuthGuard redirect is only a convenience. The two routes that let the person actually complete the
 * change (GET /auth/me and POST /auth/change-password) use `authenticateAllowingPasswordChange` instead, which runs exactly the same
 * checks and only skips this one refusal. The flag is read from the database on every request, never from the token.
 */
export const authenticate = (req: AuthenticatedRequest, res: Response, next: NextFunction) => runAuthenticate(req, res, next, false);
export const authenticateAllowingPasswordChange = (req: AuthenticatedRequest, res: Response, next: NextFunction) =>
  runAuthenticate(req, res, next, true);

export interface AuthUserRow {
  id: string;
  isActive: boolean;
  tokenVersion: number | null;
  mustChangePassword: boolean;
  customerId: string | null;
  vendorId: string | null;
  roleKey: string;
  permissions: string[];
}

/** The current account with its role key and permission keys, or null when there is no such user. One statement. */
export async function loadAuthUser(userId: string): Promise<AuthUserRow | null> {
  const rows = await prisma.$queryRaw<AuthUserRow[]>`
    SELECT u."id", u."isActive", u."tokenVersion", u."mustChangePassword", u."customerId", u."vendorId", r."key" AS "roleKey",
           COALESCE(array_agg(p."key") FILTER (WHERE p."key" IS NOT NULL), ARRAY[]::text[]) AS "permissions"
    FROM "User" u
    JOIN "Role" r ON r."id" = u."roleId"
    LEFT JOIN "RolePermission" rp ON rp."roleId" = r."id"
    LEFT JOIN "Permission" p ON p."id" = rp."permissionId"
    WHERE u."id" = ${userId}
    GROUP BY u."id", r."key"`;
  return rows[0] ?? null;
}

/** Where `authenticate` gets the account from. Always the single-statement lookup above; unit tests that have no database swap it (see test/helpers/authLookupFromUserModel.ts). */
export const authLookup: { load: (userId: string) => Promise<AuthUserRow | null> } = { load: loadAuthUser };

async function runAuthenticate(req: AuthenticatedRequest, res: Response, next: NextFunction, allowPasswordChangePending: boolean) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing bearer token" });
  }
  try {
    const payload = verifyToken(header.slice("Bearer ".length));
    // Load the user (not just the role) so we can (a) reject deactivated accounts whose
    // tokens are still valid, and (b) reflect role/permission changes immediately rather
    // than trusting the role baked into the token at sign-in time.
    // ONE database round trip for the user, the role and every permission key. The usual typed lookup (user -> role -> role permissions
    // -> permissions) is sent as one query per level, in sequence, before the real handler even starts. Only the columns used below are
    // read; the checks that follow are unchanged. This is a hand-written query for this one place only: no other query is affected.
    const user = await authLookup.load(payload.userId);
    if (!user) return res.status(401).json({ error: "Unknown user" });
    if (!user.isActive) return res.status(401).json({ error: "Account is inactive" });
    // Revocation: a password reset / change, deactivation or reactivation, a role change or a customer / vendor link change bumps
    // User.tokenVersion, so every token issued before it stops working at once (a token without a version counts as 0).
    if ((payload.tv ?? 0) !== (user.tokenVersion ?? 0)) return res.status(401).json({ error: "Your session is no longer valid - please sign in again" });

    if (user.mustChangePassword && !allowPasswordChangePending) {
      return res.status(403).json({ error: "You must change your password before continuing", code: PASSWORD_CHANGE_REQUIRED });
    }

    req.auth = {
      userId: user.id,
      roleKey: user.roleKey,
      customerId: user.customerId,
      vendorId: user.vendorId,
      permissions: new Set(user.permissions),
    };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

export function requirePermission(...permissionKeys: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.auth) return res.status(401).json({ error: "Not authenticated" });
    const hasAny = permissionKeys.some((p) => req.auth!.permissions.has(p));
    if (!hasAny) return res.status(403).json({ error: "Forbidden" });
    next();
  };
}

export function requireRole(...roleKeys: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.auth) return res.status(401).json({ error: "Not authenticated" });
    if (!roleKeys.includes(req.auth.roleKey)) return res.status(403).json({ error: "Forbidden" });
    next();
  };
}
