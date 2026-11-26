// Settings access in the web app (menu entry, route guard, direct address). The repo has no component-test runner, so - like the other screen tests - this
// reads the wiring as text, and runs the route-guard RULE (the table in AuthGuard.tsx) against the permissions the SEED gives every role
// (apps/api/prisma/rolePermissions.ts). The server enforces the same rule on every request (see apps/api/test/settingsAccess.test.ts); this is only the screen side.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROLE_DEFINITIONS } from "../../api/prisma/rolePermissions";

const root = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const guard = read("apps/admin-web/src/components/AuthGuard.tsx");
const nav = read("apps/admin-web/src/components/Nav.tsx");
const routeAccess = read("apps/admin-web/src/lib/routeAccess.ts");

const SETTINGS_ROLES = ["super_admin", "owner_admin", "management"];

/** The guard's own table: route -> permissions of which ANY grants access (entries that spread another list are skipped). */
function routeTable(): Record<string, string[]> {
  const block = /const ROUTE_PERMISSIONS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(guard)?.[1] ?? "";
  const table: Record<string, string[]> = {};
  for (const m of block.matchAll(/^\s*"([^"]+)":\s*\[([^\]]*)\]/gm)) {
    const perms = [...m[2].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
    if (perms.length) table[m[1]] = perms;
  }
  return table;
}
const matchRoute = (table: Record<string, string[]>, pathname: string) => Object.keys(table).find((r) => pathname === r || pathname.startsWith(r + "/"));
const canOpen = (permissions: string[], pathname: string) => {
  const matched = matchRoute(routeTable(), pathname);
  return matched ? routeTable()[matched].some((p) => permissions.includes(p)) : true;
};

test("the Settings route needs manage_settings and nothing else (no other permission, no role name)", () => {
  assert.deepEqual(routeTable()["/settings"], ["manage_settings"]);
  assert.doesNotMatch(guard, /role\.key\s*===\s*"(super_admin|owner_admin|management)"/, "the guard never decides by role name");
});

test("the menu shows Settings only to users holding manage_settings, and decides by permission, not by role name", () => {
  const entries = nav.match(/href=\{settingsLink\.href\}/g) ?? [];
  assert.equal(entries.length, 1, "exactly one Settings link in the menu");
  assert.match(nav, /hasPermission\("manage_settings"\) && \(\s*<Link\s+href=\{settingsLink\.href\}/, "the link sits inside the manage_settings check");
  assert.doesNotMatch(nav, /super_admin|owner_admin|"management"/, "no role name is used in the menu");
  assert.match(nav, /href: "\/settings"/);
});

test("which roles see the menu entry and may open /settings: only Super Admin, Owner / Admin and Management (by the permissions the seed gives them)", () => {
  const allowed: string[] = [];
  for (const [role, def] of Object.entries(ROLE_DEFINITIONS)) {
    const sees = def.permissions.includes("manage_settings"); // exactly what hasPermission("manage_settings") answers for that role
    const opens = canOpen(def.permissions, "/settings");
    assert.equal(opens, sees, `${role}: the menu and the route guard agree`);
    if (opens) allowed.push(role);
  }
  assert.deepEqual(allowed.sort(), [...SETTINGS_ROLES].sort());
});

test("typing the address does not bypass the guard: /settings and anything under it need the permission", () => {
  for (const path of ["/settings", "/settings/", "/settings/anything", "/settings/x/y"]) {
    for (const role of Object.keys(ROLE_DEFINITIONS).filter((r) => !SETTINGS_ROLES.includes(r))) assert.equal(canOpen(ROLE_DEFINITIONS[role].permissions, path), false, `${role} ${path}`);
    for (const role of SETTINGS_ROLES) assert.equal(canOpen(ROLE_DEFINITIONS[role].permissions, path), true, `${role} ${path}`);
  }
  // What the guard does with a staff user who lacks the permission: sends them to a page they can open (it renders nothing for the blocked route).
  assert.match(guard, /const matched = matchRoute\(pathname\);\s*if \(matched && !canAccess\(user\.permissions, matched\)\) \{\s*const landing = firstLanding\(user\.permissions\);\s*if \(landing\) router\.push\(landing\);/);
  // A customer can open only the portal and their own service reports - never /settings.
  assert.match(guard, /user\.role\.key === "customer"[\s\S]{0,120}router\.push\("\/customer\/portal"\)/);
  assert.doesNotMatch(routeAccess, /settings/, "the customer allow-list does not mention settings");
});

test("Settings is not a public path and not in the disabled-page list", () => {
  assert.doesNotMatch(/const PUBLIC_PATHS[^;]*;/.exec(guard)?.[0] ?? "", /settings/);
  assert.doesNotMatch(/const DISABLED_ROUTES[^;]*;/.exec(guard)?.[0] ?? "", /settings/);
});

test("sections that load or change data check manage_settings themselves too (SLA, assistant visibility, assistant providers); the rest rely on the guarded page and the API", () => {
  for (const f of ["SlaSettings", "AgentVisibilitySettings", "AgentProvidersSettings"]) {
    const src = read(`apps/admin-web/src/components/${f}.tsx`);
    assert.match(src, /hasPermission\("manage_settings"\)/, f);
    assert.match(src, /if \(!canManage[^\n]*return null/, `${f} renders nothing without the permission`);
  }
  const page = read("apps/admin-web/src/app/settings/page.tsx");
  for (const c of ["SlaSettings", "ReminderSettings", "AmcSettings", "WarrantySettings", "AgentVisibilitySettings", "AgentProvidersSettings"]) assert.match(page, new RegExp(`<${c} />`), c);
});
