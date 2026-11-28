/**
 * Real-database tests for the item catalogue fields of the Items page (the "New Item" popup): Item Code, Description, HSN/SAC type, HSN/SAC number and
 * Unit, stored next to the existing Model and technical fields - through the real products router, real authentication and the real Prisma client.
 *
 * Covers: the five fields are stored and returned (create, read, list, update); Item Code is a code of its own (not Model) and is unique ignoring case and
 * surrounding spaces, at the API AND at the database; Model is still unique; items created WITHOUT the new fields (the Orders form, the AI assistant, older
 * rows) still work; the HSN/SAC type and the Unit only accept their lists while the HSN/SAC number is free text; the existing technical fields and the
 * default warranty duration survive a create / update.
 *
 * SAFETY: these tests WRITE rows. They refuse to run unless BOTH DATABASE_URL and DIRECT_URL point at a disposable local database (localhost:5434/platino_test,
 * or the explicit throw-away override in test/helpers/isolatedDb.ts) and they only touch rows they create themselves (unique run prefix, removed in `after`).
 */
import "dotenv/config";
import { allowedByTestOverride, expectedTestDatabase } from "../helpers/isolatedDb";
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";

const ISOLATED = { hosts: ["localhost", "127.0.0.1"], port: "5434", database: "platino_test" };

function pointsAtIsolatedDb(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return ISOLATED.hosts.includes(u.hostname) && u.port === ISOLATED.port && u.pathname === `/${ISOLATED.database}`;
  } catch {
    return false;
  }
}

const isolated = (pointsAtIsolatedDb(process.env.DATABASE_URL) || allowedByTestOverride(process.env.DATABASE_URL)) && (pointsAtIsolatedDb(process.env.DIRECT_URL) || allowedByTestOverride(process.env.DIRECT_URL)) && !!process.env.JWT_SECRET;
const skip = isolated
  ? false
  : "DATABASE_URL / DIRECT_URL are not both the isolated local test database (localhost:5434/platino_test), or JWT_SECRET is missing - refusing to touch any database";

describe("item catalogue fields against the real test database", { skip }, () => {
  const PREFIX = `ZI${Date.now().toString(36).toUpperCase()}`;
  const productIds = new Set<string>();
  const userIds = new Set<string>();
  let seq = 0;
  const realConsole = { log: console.log, error: console.error };

  let prisma: any;
  let server: Server;
  let base = "";
  let signToken: (p: any) => string;
  let manager: any;
  let engineer: any;

  const code = (tag: string) => `${PREFIX}-${tag}-${++seq}`;
  const call = async (as: any, method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(as ? { authorization: `Bearer ${signToken({ userId: as.id, roleKey: "x", customerId: null })}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, body: json };
  };
  async function create(over: Record<string, unknown> = {}) {
    const n = ++seq;
    const r = await call(manager, "POST", "/products", { name: `${PREFIX} item ${n}`, model: `${PREFIX}-M${n}`, ...over });
    if (r.status === 201) productIds.add(r.body.id);
    return r;
  }
  const full = (tag: string, over: Record<string, unknown> = {}) => ({
    itemCode: code(tag), description: "Retrofit emission control device, demo", hsnSacType: "HSN", hsnSacNo: "8421 99 00 (free text)", unitOfMeasure: "Nos", ...over,
  });

  before(async () => {
    console.log = () => {};
    console.error = () => {};
    ({ prisma } = await import("../../src/lib/prisma"));
    const [{ db }] = await prisma.$queryRaw`select current_database() as db`;
    assert.equal(db, expectedTestDatabase(ISOLATED.database), "connected to the wrong database - aborting");
    ({ signToken } = await import("../../src/lib/jwt"));
    const { productsRouter } = await import("../../src/routes/products");
    const app = express();
    app.use(express.json());
    app.use("/products", productsRouter);
    app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: "Internal server error" }); });
    await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const mgmt = await prisma.role.findUniqueOrThrow({ where: { key: "management" } });
    const eng = await prisma.role.findUniqueOrThrow({ where: { key: "service_engineer" } });
    manager = await prisma.user.create({ data: { name: `${PREFIX} manager`, roleId: mgmt.id, isActive: true, mustChangePassword: false } });
    engineer = await prisma.user.create({ data: { name: `${PREFIX} engineer`, roleId: eng.id, isActive: true, mustChangePassword: false } });
    userIds.add(manager.id).add(engineer.id);
  });

  after(async () => {
    server?.close();
    try {
      if (prisma) {
        await prisma.product.deleteMany({ where: { id: { in: [...productIds] } } });
        await prisma.user.deleteMany({ where: { id: { in: [...userIds] } } });
      }
    } finally {
      await prisma?.$disconnect();
      console.log = realConsole.log;
      console.error = realConsole.error;
    }
  });

  test("migration objects: five NEW nullable columns, a case-insensitive unique index on Item Code, and Model's own unique index is untouched", async () => {
    const cols: Array<{ column_name: string; is_nullable: string; data_type: string }> = await prisma.$queryRaw`
      select column_name, is_nullable, data_type from information_schema.columns where table_schema='public' and table_name='Product'`;
    for (const c of ["itemCode", "description", "hsnSacType", "hsnSacNo", "unitOfMeasure"]) {
      const col = cols.find((x) => x.column_name === c);
      assert.ok(col, `${c} exists`);
      assert.equal(col!.is_nullable, "YES", `${c} is nullable (existing rows and other creation paths stay valid)`);
      assert.equal(col!.data_type, "text");
    }
    const old = ["id", "name", "model", "ratingSpec", "capacityKva", "warrantyMonths", "shape", "dimensions", "weightKg", "silencerType", "createdAt"];
    for (const c of old) assert.ok(cols.some((x) => x.column_name === c), `existing column ${c} is still there`);
    const idx: Array<{ indexname: string; indexdef: string }> = await prisma.$queryRaw`select indexname, indexdef from pg_indexes where schemaname='public' and tablename='Product'`;
    assert.ok(idx.some((i) => i.indexname === "Product_model_key" && /UNIQUE/.test(i.indexdef)), "Model stays unique");
    assert.ok(idx.some((i) => i.indexname === "Product_itemCode_lower_key" && /UNIQUE/.test(i.indexdef) && /lower\(/.test(i.indexdef)), "Item Code is unique ignoring case");
  });

  test("create with every field: stored, returned by create, read and list - Item Code and Model are separate values", async () => {
    const f = full("ALL", { ratingSpec: "250 kVA DG sets", capacityKva: 250, warrantyMonths: 24, shape: "cylinder", dimensions: "1200 x 600 mm", weightKg: 80.5, silencerType: 2 });
    const r = await create(f);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    for (const k of ["itemCode", "description", "hsnSacType", "hsnSacNo", "unitOfMeasure", "ratingSpec", "shape", "dimensions", "silencerType"]) assert.equal(r.body[k], (f as any)[k], k);
    assert.equal(Number(r.body.capacityKva), 250);
    assert.equal(r.body.warrantyMonths, 24);
    assert.notEqual(r.body.itemCode, r.body.model, "Item Code is not the Model");
    const one = await call(manager, "GET", `/products/${r.body.id}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.itemCode, f.itemCode);
    assert.equal(one.body.hsnSacType, "HSN");
    assert.equal(one.body.hsnSacNo, f.hsnSacNo);
    assert.equal(one.body.unitOfMeasure, "Nos");
    assert.equal(one.body.description, f.description);
    const list = await call(manager, "GET", "/products");
    const row = list.body.find((p: any) => p.id === r.body.id);
    assert.ok(row && row.itemCode === f.itemCode && row.unitOfMeasure === "Nos" && row.hsnSacType === "HSN");
    const inDb = await prisma.product.findUniqueOrThrow({ where: { id: r.body.id } });
    assert.equal(inDb.itemCode, f.itemCode);
    assert.equal(inDb.hsnSacNo, f.hsnSacNo);
  });

  test("values are trimmed; the HSN/SAC number is FREE TEXT (no format is enforced yet)", async () => {
    const c = code("TRIM");
    const r = await create({ itemCode: `  ${c}  `, description: "  spaced  ", hsnSacType: "SAC", hsnSacNo: "  ab-12 / x  ", unitOfMeasure: "SET" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.itemCode, c);
    assert.equal(r.body.description, "spaced");
    assert.equal(r.body.hsnSacType, "SAC");
    assert.equal(r.body.hsnSacNo, "ab-12 / x");
    for (const no of ["8421", "842199", "not a number", "99-9999.9"]) assert.equal((await create({ hsnSacNo: no })).status, 201, `accepted: ${no}`);
  });

  test("HSN/SAC type and Unit accept only their lists (HSN | SAC; Nos | LTR | MTR | KG | SET)", async () => {
    for (const t of ["HSN", "SAC"]) assert.equal((await create({ hsnSacType: t })).status, 201, t);
    for (const u of ["Nos", "LTR", "MTR", "KG", "SET"]) assert.equal((await create({ unitOfMeasure: u })).status, 201, u);
    for (const bad of [{ hsnSacType: "GST" }, { hsnSacType: "hsn" }, { unitOfMeasure: "BOX" }, { unitOfMeasure: "nos" }, { itemCode: "" }, { itemCode: "   " }, { itemCode: "x".repeat(61) }]) {
      const r = await create(bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
  });

  test("Item Code is unique ignoring case and surrounding spaces - at the API", async () => {
    const c = code("UNIQ");
    assert.equal((await create({ itemCode: c })).status, 201);
    for (const dup of [c, c.toLowerCase(), c.toUpperCase(), `  ${c}  `]) {
      const r = await create({ itemCode: dup });
      assert.equal(r.status, 400, dup);
      assert.match(r.body.error, /Item Code already exists/);
    }
    assert.equal((await create({ itemCode: `${c}-2` })).status, 201, "a different code is fine");
  });

  test("Item Code is unique ignoring case - at the DATABASE too (two saves at the same moment cannot both win)", async () => {
    const c = code("DB");
    await prisma.product.create({ data: { name: `${PREFIX} raw1`, model: code("RAWM"), itemCode: c } }).then((p: any) => productIds.add(p.id));
    await assert.rejects(
      () => prisma.product.create({ data: { name: `${PREFIX} raw2`, model: code("RAWM"), itemCode: c.toLowerCase() } }),
      (err: any) => err.code === "P2002",
      "the lower() unique index refuses the same code in another case",
    );
    // the route turns a race that reaches the index into a clear 400, not a 500
    const a = create({ itemCode: code("RACE") });
    const sameCode = (await a).body.itemCode as string;
    const results = await Promise.all([create({ itemCode: sameCode.toLowerCase() }), create({ itemCode: sameCode.toUpperCase() })]);
    assert.ok(results.every((r) => r.status === 400), JSON.stringify(results.map((r) => r.status)));
  });

  test("any number of items may have NO Item Code (older items, the Orders form and the AI assistant create them that way)", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await create(); // name + model only, exactly what the Orders form sends (plus ratingSpec)
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.itemCode, null);
      assert.equal(r.body.unitOfMeasure, null);
      assert.equal(r.body.hsnSacType, null);
    }
    const orders = await create({ ratingSpec: "from the inline Orders form" });
    assert.equal(orders.status, 201);
  });

  test("Model is still required and unique, and Item Code and Model are independent (the same text may be one item's Model and another's Item Code)", async () => {
    const m = code("MODEL");
    assert.equal((await create({ model: m })).status, 201);
    const dup = await create({ model: m });
    assert.equal(dup.status, 400);
    assert.match(dup.body.error, /model already exists/);
    assert.equal((await call(manager, "POST", "/products", { name: "no model", itemCode: code("NM") })).status, 400, "Model is still required");
    const shared = code("SAMETEXT");
    assert.equal((await create({ model: shared })).status, 201);
    assert.equal((await create({ itemCode: shared })).status, 201, "the same text as another item's Model is fine as an Item Code");
  });

  test("update: set the new fields on an older item, change them, keep your own code (even in another case), never take another item's code; other fields are kept", async () => {
    const old = await create({ ratingSpec: "old item", warrantyMonths: 36, capacityKva: 500, shape: "triangle", silencerType: 1 });
    assert.equal(old.status, 201);
    const id = old.body.id;
    const other = await create({ itemCode: code("OTHER") });
    const mine = code("MINE");
    const set = await call(manager, "PUT", `/products/${id}`, { itemCode: mine, hsnSacType: "SAC", hsnSacNo: "9988", unitOfMeasure: "LTR", description: "now described" });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.itemCode, mine);
    assert.equal(set.body.unitOfMeasure, "LTR");
    assert.equal(set.body.warrantyMonths, 36, "the default warranty duration is untouched");
    assert.equal(Number(set.body.capacityKva), 500);
    assert.equal(set.body.shape, "triangle");
    assert.equal(set.body.silencerType, 1);
    assert.equal(set.body.ratingSpec, "old item");
    assert.equal((await call(manager, "PUT", `/products/${id}`, { itemCode: mine.toLowerCase() })).status, 200, "own code, other case");
    const taken = await call(manager, "PUT", `/products/${id}`, { itemCode: other.body.itemCode.toLowerCase() });
    assert.equal(taken.status, 400);
    assert.match(taken.body.error, /Item Code already exists/);
    assert.equal((await prisma.product.findUniqueOrThrow({ where: { id } })).itemCode, mine.toLowerCase(), "the refused change did not alter the item");
    assert.equal((await call(manager, "PUT", `/products/${id}`, { hsnSacType: "XYZ" })).status, 400);
    assert.equal((await call(manager, "PUT", `/products/${id}`, { warrantyMonths: 12 })).status, 200);
    assert.equal((await prisma.product.findUniqueOrThrow({ where: { id } })).unitOfMeasure, "LTR", "a partial update keeps the new fields");
  });

  test("existing technical fields and the default warranty duration are stored exactly as before", async () => {
    const r = await create({ ratingSpec: "spec", capacityKva: 380.5, warrantyMonths: 18, shape: "rectangle", dimensions: "1 x 2 x 3", weightKg: 12.25, silencerType: 2 });
    assert.equal(r.status, 201);
    const row = await prisma.product.findUniqueOrThrow({ where: { id: r.body.id } });
    assert.equal(Number(row.capacityKva), 380.5);
    assert.equal(row.warrantyMonths, 18);
    assert.equal(row.shape, "rectangle");
    assert.equal(row.dimensions, "1 x 2 x 3");
    assert.equal(Number(row.weightKg), 12.25);
    assert.equal(row.silencerType, 2);
    // the unit-warranty logic still reads the product's duration as the default
    const { planWarranty } = await import("@recd/shared");
    const plan = planWarranty({ startDate: "2026-02-01" }, row.warrantyMonths);
    assert.ok(plan.ok && plan.months === 18 && plan.source === "product_default", "a unit warranty started from the item's default months is planned as before");
  });

  test("permissions are unchanged: only holders of manage_orders may create or edit items; the new fields are not an extra door", async () => {
    assert.equal((await call(engineer, "POST", "/products", { name: "x", model: code("DENY"), ...full("DENY") })).status, 403);
    assert.equal((await call(null, "POST", "/products", { name: "x", model: code("NOAUTH") })).status, 401);
    const mine = await create(full("PERM"));
    assert.equal((await call(engineer, "PUT", `/products/${mine.body.id}`, { itemCode: code("HACK") })).status, 403);
    assert.equal((await call(engineer, "GET", `/products/${mine.body.id}`)).status, 403);
  });

  test("an unused item can still be deleted", async () => {
    const r = await create(full("DEL"));
    assert.equal((await call(manager, "DELETE", `/products/${r.body.id}`)).status, 204);
    productIds.delete(r.body.id);
    assert.equal(await prisma.product.count({ where: { id: r.body.id } }), 0);
  });
});
