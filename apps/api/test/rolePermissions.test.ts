// The default role permissions (prisma/rolePermissions.ts, what the seed writes). The "before" lists below are frozen on purpose: they are what each role
// held before Owner / Admin and Management were given manage_settings, so any other change to any role fails here and has to be a conscious edit.
import test from "node:test";
import assert from "node:assert/strict";
import { PERMISSION_KEY, ROLE_KEY } from "@recd/shared";
import { ALL_PERMISSIONS, ROLE_DEFINITIONS } from "../prisma/rolePermissions";

const sorted = (xs: readonly string[]) => [...xs].sort();
const of = (role: string) => sorted(ROLE_DEFINITIONS[role].permissions);

const ADMIN_BEFORE = [
  "act_assigned_complaints", "change_site_status", "manage_amc_orders", "manage_complaints", "manage_orders", "manage_regions", "manage_users", "manage_vendors",
  "manage_warranty", "raise_complaint", "resolve_pending_action", "view_complaints_overview", "view_dashboard", "view_site_status",
];

const UNCHANGED: Record<string, string[]> = {
  [ROLE_KEY.SALES]: ["manage_orders", "view_site_status"],
  [ROLE_KEY.OPERATIONS_PM]: ["change_site_status", "resolve_pending_action", "view_site_status"],
  [ROLE_KEY.ERECTION_ENGINEER]: ["act_assigned_complaints", "change_site_status", "view_site_status"],
  [ROLE_KEY.COMMISSIONING_ENGINEER]: ["act_assigned_complaints", "change_site_status", "view_site_status"],
  [ROLE_KEY.SERVICE_TEAM]: ["manage_complaints", "view_site_status"],
  [ROLE_KEY.FINANCE]: [],
  [ROLE_KEY.REGIONAL_MANAGER]: ["manage_complaints", "view_complaints_overview", "view_dashboard", "view_site_status"],
  [ROLE_KEY.SERVICE_MANAGER]: ["manage_complaints", "view_complaints_overview", "view_dashboard", "view_site_status"],
  [ROLE_KEY.SERVICE_ENGINEER]: ["act_assigned_complaints", "view_site_status"],
  [ROLE_KEY.CUSTOMER]: ["raise_complaint", "resolve_pending_action", "view_site_status"],
};

test("Super Admin keeps every permission, manage_settings included", () => {
  assert.deepEqual(of(ROLE_KEY.SUPER_ADMIN), sorted(ALL_PERMISSIONS));
  assert.ok(of(ROLE_KEY.SUPER_ADMIN).includes(PERMISSION_KEY.MANAGE_SETTINGS));
});

for (const role of [ROLE_KEY.OWNER_ADMIN, ROLE_KEY.MANAGEMENT]) {
  test(`${role}: gains manage_settings and NOTHING else`, () => {
    const now = of(role);
    assert.ok(now.includes(PERMISSION_KEY.MANAGE_SETTINGS), "has manage_settings");
    assert.deepEqual(now.filter((p) => p !== PERMISSION_KEY.MANAGE_SETTINGS), ADMIN_BEFORE, "everything else is exactly what it had before");
    assert.deepEqual(now, sorted([...ADMIN_BEFORE, PERMISSION_KEY.MANAGE_SETTINGS]));
    assert.equal(new Set(now).size, now.length, "no duplicates");
  });
}

test("every other role is exactly as before - no role other than Super Admin, Owner / Admin and Management holds manage_settings", () => {
  for (const [role, expected] of Object.entries(UNCHANGED)) assert.deepEqual(of(role), expected, role);
  const known = new Set([ROLE_KEY.SUPER_ADMIN, ROLE_KEY.OWNER_ADMIN, ROLE_KEY.MANAGEMENT, ...Object.keys(UNCHANGED)]);
  assert.deepEqual(sorted(Object.keys(ROLE_DEFINITIONS)), sorted([...known]), "no role was added or removed without updating this test");
  const holders = Object.entries(ROLE_DEFINITIONS).filter(([, d]) => d.permissions.includes(PERMISSION_KEY.MANAGE_SETTINGS)).map(([k]) => k);
  assert.deepEqual(sorted(holders), sorted([ROLE_KEY.SUPER_ADMIN, ROLE_KEY.OWNER_ADMIN, ROLE_KEY.MANAGEMENT]));
});

test("every permission a role is given is a real permission", () => {
  const real = new Set(Object.values(PERMISSION_KEY) as string[]);
  for (const [role, def] of Object.entries(ROLE_DEFINITIONS)) for (const p of def.permissions) assert.ok(real.has(p), `${role}: ${p}`);
});

test("phone-code sign-in stays closed to Owner / Admin and Management (they were already denied by role, and now also hold a denied permission)", async () => {
  const { isPhoneOtpLoginAllowed } = await import("@recd/shared");
  for (const role of [ROLE_KEY.SUPER_ADMIN, ROLE_KEY.OWNER_ADMIN, ROLE_KEY.MANAGEMENT]) {
    assert.equal(isPhoneOtpLoginAllowed({ role: { key: role, permissions: ROLE_DEFINITIONS[role].permissions.map((key) => ({ permission: { key } })) } }), false, role);
  }
});
