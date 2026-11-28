// The item (product) validation used by the Items page, the Orders form and the AI assistant: the catalogue fields are optional and checked, and the
// existing fields are unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { HSN_SAC_TYPE, PRODUCT_UNIT, createProductSchema, updateProductSchema } from "../src";

const base = { name: "Platino RECD", model: "RECD-250" };

test("the existing item (name + model only) is still valid: the new catalogue fields are optional here, so the Orders form and the AI assistant keep working", () => {
  assert.ok(createProductSchema.safeParse(base).success);
  assert.ok(createProductSchema.safeParse({ ...base, ratingSpec: "250 kVA", capacityKva: 250, warrantyMonths: 24, shape: "cylinder", dimensions: "1 x 2", weightKg: 9, silencerType: 2 }).success);
  assert.equal(createProductSchema.safeParse({ model: "x" }).success, false, "name is still required");
  assert.equal(createProductSchema.safeParse({ name: "x" }).success, false, "model is still required");
});

test("the catalogue fields are accepted, trimmed and typed; the HSN/SAC number is free text", () => {
  const r = createProductSchema.safeParse({ ...base, itemCode: "  PLT-1  ", description: " d ", hsnSacType: "HSN", hsnSacNo: " 8421 / free text ", unitOfMeasure: "Nos" });
  assert.ok(r.success);
  if (r.success) {
    assert.equal(r.data.itemCode, "PLT-1");
    assert.equal(r.data.description, "d");
    assert.equal(r.data.hsnSacNo, "8421 / free text");
  }
  for (const no of ["8421", "842199", "abc", "12-34.56", "x".repeat(30)]) assert.ok(createProductSchema.safeParse({ ...base, hsnSacNo: no }).success, no);
  assert.equal(createProductSchema.safeParse({ ...base, hsnSacNo: "x".repeat(31) }).success, false, "a sane length limit only");
});

test("HSN/SAC type and Unit accept only their approved lists", () => {
  assert.deepEqual(Object.values(HSN_SAC_TYPE), ["HSN", "SAC"]);
  assert.deepEqual(Object.values(PRODUCT_UNIT), ["Nos", "LTR", "MTR", "KG", "SET"]);
  for (const t of Object.values(HSN_SAC_TYPE)) assert.ok(createProductSchema.safeParse({ ...base, hsnSacType: t }).success, t);
  for (const u of Object.values(PRODUCT_UNIT)) assert.ok(createProductSchema.safeParse({ ...base, unitOfMeasure: u }).success, u);
  for (const bad of ["GST", "hsn", "", "Both"]) assert.equal(createProductSchema.safeParse({ ...base, hsnSacType: bad }).success, false, `type ${bad}`);
  for (const bad of ["BOX", "nos", "", "Pcs"]) assert.equal(createProductSchema.safeParse({ ...base, unitOfMeasure: bad }).success, false, `unit ${bad}`);
});

test("Item Code: not blank, at most 60 characters", () => {
  for (const bad of ["", "   ", "x".repeat(61)]) assert.equal(createProductSchema.safeParse({ ...base, itemCode: bad }).success, false, JSON.stringify(bad));
  assert.ok(createProductSchema.safeParse({ ...base, itemCode: "x".repeat(60) }).success);
});

test("update accepts any subset, including only the new fields, and still rejects bad values", () => {
  assert.ok(updateProductSchema.safeParse({}).success);
  assert.ok(updateProductSchema.safeParse({ itemCode: "NEW-1" }).success);
  assert.ok(updateProductSchema.safeParse({ unitOfMeasure: "KG", hsnSacType: "SAC", hsnSacNo: "9988" }).success);
  assert.equal(updateProductSchema.safeParse({ unitOfMeasure: "BOX" }).success, false);
  assert.equal(updateProductSchema.safeParse({ silencerType: 3 }).success, false, "existing rules unchanged");
});
