/**
 * Real-database check that a staff user can be created and edited WITHOUT a mobile number (User.phone is nullable;
 * several users may have none, because only real numbers are unique), and that a given number is still stored as
 * 10 digits and still refused when another user holds it.
 *
 * SAFETY: WRITES rows. Refuses to run unless BOTH DATABASE_URL and DIRECT_URL point at the disposable Docker
 * database (localhost:5434/platino_test). Only touches rows it creates itself (unique prefix, removed in `after`).
 * Run with:  npm run test:db --workspace=apps/api
 */
import "dotenv/config";
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";

function pointsAtIsolatedDb(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return ["localhost", "127.0.0.1"].includes(u.hostname) && u.port === "5434" && u.pathname === "/platino_test";
  } catch {
    return false;
  }
}
const isolated = pointsAtIsolatedDb(process.env.DATABASE_URL) && pointsAtIsolatedDb(process.env.DIRECT_URL) && !!process.env.JWT_SECRET;
const skip = isolated ? false : "DATABASE_URL / DIRECT_URL are not both the isolated local test database (localhost:5434/platino_test) - refusing to touch any database";

/* eslint-disable @typescript-eslint/no-explicit-any */
describe("staff user without a mobile number (real test database)", { skip }, () => {
  const PREFIX = `zopt${Date.now().toString(36)}`;
  let prisma: any;
  let admin: typeof import("../../src/lib/userAdmin");
  let actor: { userId: string; roleKey: string };
  const ids: string[] = [];
  const email = (tag: string) => `${PREFIX}.${tag}@example.test`;

  before(async () => {
    prisma = (await import("../../src/lib/prisma")).prisma;
    admin = await import("../../src/lib/userAdmin");
    const sa = await prisma.user.findFirst({ where: { role: { key: "super_admin" }, isActive: true } });
    assert.ok(sa, "the test database must be seeded (needs a Super Admin)");
    actor = { userId: sa.id, roleKey: "super_admin" };
  });
  after(async () => {
    if (!prisma) return;
    await prisma.userAuditLog.deleteMany({ where: { OR: [{ targetUserId: { in: ids } }, { actorId: { in: ids } }] } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  test("create with no number (twice, so the unique index does not trip), then with a number, then a duplicate", async () => {
    const a = await admin.createUser(actor, { name: "No Phone A", email: email("a"), roleKey: "sales" });
    const b = await admin.createUser(actor, { name: "No Phone B", email: email("b"), roleKey: "sales" });
    ids.push(a.user.id, b.user.id);
    const rowA = await prisma.user.findUnique({ where: { id: a.user.id } });
    const rowB = await prisma.user.findUnique({ where: { id: b.user.id } });
    assert.equal(rowA.phone, null);
    assert.equal(rowB.phone, null);

    const number = `9${String(Date.now()).slice(-9)}`;
    const c = await admin.createUser(actor, { name: "With Phone", email: email("c"), roleKey: "sales", phone: number });
    ids.push(c.user.id);
    assert.equal((await prisma.user.findUnique({ where: { id: c.user.id } })).phone, number);
    await assert.rejects(admin.createUser(actor, { name: "Dup", email: email("d"), roleKey: "sales", phone: number }), (e: any) => e.status === 409);

    // editing a user that has no number works, and a number can be added later
    await admin.updateUser(actor, a.user.id, { name: "No Phone A renamed" });
    assert.equal((await prisma.user.findUnique({ where: { id: a.user.id } })).phone, null);
    const added = `9${String(Date.now() + 7).slice(-9)}`;
    await admin.updateUser(actor, a.user.id, { phone: added });
    assert.equal((await prisma.user.findUnique({ where: { id: a.user.id } })).phone, added);
  });
});
