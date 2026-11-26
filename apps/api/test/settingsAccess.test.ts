// Who may use Settings through the API. The REAL settings and assistant-provider routers (with the real authentication and permission middleware) run over
// HTTP; the database is replaced by tiny in-memory stand-ins, and each test user gets the permissions the SEED gives its role (prisma/rolePermissions.ts),
// so a change to the role definitions is felt here. Reading settings is open to every signed-in user (with a reduced view for customers); every CHANGE,
// and the whole assistant-provider area, needs manage_settings - held by Super Admin, Owner / Admin and Management and nobody else.
process.env.JWT_SECRET = "test-secret";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
process.env.DIRECT_URL = process.env.DATABASE_URL;

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { ROLE_KEY, PERMISSION_KEY } from "@recd/shared";
import { ROLE_DEFINITIONS } from "../prisma/rolePermissions";
import { useUserModelForAuth } from "./helpers/authLookupFromUserModel";

const SETTINGS_ROLES = [ROLE_KEY.SUPER_ADMIN, ROLE_KEY.OWNER_ADMIN, ROLE_KEY.MANAGEMENT] as string[];
const OTHER_ROLES = Object.keys(ROLE_DEFINITIONS).filter((k) => !SETTINGS_ROLES.includes(k));

// One user per built-in role; the customer role is a customer contact.
const users: Record<string, { id: string; role: string; perms: string[]; customerId?: string }> = Object.fromEntries(
  Object.entries(ROLE_DEFINITIONS).map(([key, def]) => [key, { id: `u-${key}`, role: key, perms: def.permissions, ...(key === ROLE_KEY.CUSTOMER ? { customerId: "c1" } : {}) }]),
);

const ROW = {
  id: "singleton", themeKey: "emerald", logoDataUrl: null, customColors: null, legalName: "Platino", address: "A", city: "C", pinCode: "1", email: "e@x", website: "w", phone: "p",
  documentFooterNote: null, agentVisibleRoleKeys: ["super_admin"], agentCustomInstructions: "internal rules",
  slaRegionalManagerHours: 24, slaManagementHours: 48, reminderLeadDays: 3, reminderEscalationHours: 24, amcDefaultDurationMonths: 12, amcReminderLeadDays: 30, amcReminderRepeatDays: 3,
  warrantyReminderLeadDays: 30, warrantyReminderRepeatDays: 3,
};
let writes = 0;

let server: Server;
let base = "";
let signToken: (p: any) => string;

before(async () => {
  const { prisma } = await import("../src/lib/prisma");
  await useUserModelForAuth(prisma);
  ({ signToken } = await import("../src/lib/jwt"));
  const { settingsRouter } = await import("../src/routes/settings");
  const { agentProvidersRouter } = await import("../src/routes/agentProviders");
  const delegates: Record<string, any> = {
    user: {
      findUnique: ({ where }: any) => {
        const u = Object.values(users).find((x) => x.id === where.id);
        return u ? { id: u.id, isActive: true, tokenVersion: null, mustChangePassword: false, customerId: u.customerId ?? null, vendorId: null, role: { key: u.role, permissions: u.perms.map((key) => ({ permission: { key } })) } } : null;
      },
    },
    companySettings: {
      findUnique: () => ({ ...ROW }),
      upsert: ({ update }: any) => { writes++; return { ...ROW, ...update }; },
    },
    agentLlmProvider: { findMany: () => [], findUnique: () => null, delete: () => ({}), create: () => ({}), update: () => ({}) },
  };
  for (const [name, impl] of Object.entries(delegates)) Object.defineProperty(prisma, name, { configurable: true, get: () => impl });
  const app = express();
  app.use(express.json());
  app.use("/settings", settingsRouter);
  app.use("/agent", agentProvidersRouter);
  app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: "Internal server error" }); });
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server?.close(); });

async function call(as: string | null, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(as ? { authorization: `Bearer ${signToken({ userId: users[as].id, roleKey: users[as].role })}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// Every settings section and the request that changes it.
const CHANGES: Array<[string, string, unknown]> = [
  ["company settings (branding, theme, letterhead, assistant visibility)", "/settings", { legalName: "Platino", themeKey: "emerald" }],
  ["SLA", "/settings/sla", { slaRegionalManagerHours: 24, slaManagementHours: 48 }],
  ["service reminders", "/settings/reminders", { reminderLeadDays: 3, reminderEscalationHours: 24 }],
  ["AMC", "/settings/amc", { amcDefaultDurationMonths: 12, amcReminderLeadDays: 30, amcReminderRepeatDays: 3 }],
  ["warranty reminders", "/settings/warranty", { warrantyReminderLeadDays: 30, warrantyReminderRepeatDays: 3 }],
];

test("the roles that hold manage_settings are exactly Super Admin, Owner / Admin and Management", () => {
  const holders = Object.entries(ROLE_DEFINITIONS).filter(([, d]) => d.permissions.includes(PERMISSION_KEY.MANAGE_SETTINGS)).map(([k]) => k).sort();
  assert.deepEqual(holders, [...SETTINGS_ROLES].sort());
});

for (const role of SETTINGS_ROLES) {
  test(`${role}: can read and change every Settings section`, async () => {
    for (const [label, path, body] of CHANGES) {
      const before = writes;
      const r = await call(role, "PUT", path, body);
      assert.equal(r.status, 200, `${label}: ${JSON.stringify(r.body)}`);
      assert.equal(writes, before + 1, `${label}: the change reached the database`);
    }
    const view = await call(role, "GET", "/settings");
    assert.equal(view.status, 200);
    assert.equal(view.body.agentCustomInstructions, "internal rules", "sees the assistant instructions");
    assert.equal(view.body.slaRegionalManagerHours, 24);
  });

  test(`${role}: can use the assistant-provider area (list, add, change, delete, list models) - refused only for bad input, never for permission`, async () => {
    assert.equal((await call(role, "GET", "/agent/providers")).status, 200);
    for (const [method, path] of [["POST", "/agent/providers"], ["PUT", "/agent/providers/p1"], ["DELETE", "/agent/providers/p1"], ["POST", "/agent/providers/list-models"]] as const) {
      const r = await call(role, method, path, {});
      assert.ok(r.status !== 401 && r.status !== 403, `${method} ${path} -> ${r.status}`);
    }
  });
}

for (const role of OTHER_ROLES) {
  test(`${role}: cannot change any Settings section and cannot use the assistant-provider area (403), and nothing is written`, async () => {
    const before = writes;
    for (const [label, path, body] of CHANGES) {
      const r = await call(role, "PUT", path, body);
      assert.equal(r.status, 403, `${label} must be refused`);
    }
    assert.equal(writes, before, "no settings were written");
    for (const [method, path] of [["GET", "/agent/providers"], ["POST", "/agent/providers"], ["PUT", "/agent/providers/p1"], ["DELETE", "/agent/providers/p1"], ["POST", "/agent/providers/list-models"]] as const) {
      assert.equal((await call(role, method, path, method === "GET" ? undefined : {})).status, 403, `${method} ${path}`);
    }
  });
}

test("reading settings: every signed-in user may read (customers only branding and contact details); staff without manage_settings never see the assistant instructions", async () => {
  for (const role of Object.keys(users)) {
    const r = await call(role, "GET", "/settings");
    assert.equal(r.status, 200, role);
    if (role === ROLE_KEY.CUSTOMER) {
      assert.ok(!("slaRegionalManagerHours" in r.body) && !("agentCustomInstructions" in r.body), "a customer gets branding and contact details only");
      assert.equal(r.body.legalName, "Platino");
    } else if (!SETTINGS_ROLES.includes(role)) {
      assert.ok(!("agentCustomInstructions" in r.body), `${role} must not see the assistant instructions`);
      assert.equal(r.body.slaRegionalManagerHours, 24, `${role} sees the policies (read only)`);
    }
  }
});

test("nobody signed out can read or change anything (401)", async () => {
  assert.equal((await call(null, "GET", "/settings")).status, 401);
  for (const [, path, body] of CHANGES) assert.equal((await call(null, "PUT", path, body)).status, 401, path);
  assert.equal((await call(null, "GET", "/agent/providers")).status, 401);
});
