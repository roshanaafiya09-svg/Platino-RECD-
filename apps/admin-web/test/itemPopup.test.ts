// The redesigned "New Item" popup on the Items page. The repo has no component-test runner, so these are source-level checks (reading the files as text);
// the look itself was checked in the running app (see the report).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { HSN_SAC_TYPE, PRODUCT_UNIT } from "@recd/shared";

const root = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8").replace(/\r\n/g, "\n");
const page = read("apps/admin-web/src/app/products/page.tsx");
const detail = read("apps/admin-web/src/app/products/[id]/page.tsx");
const css = read("apps/admin-web/src/app/globals.css");
const orders = read("apps/admin-web/src/app/orders/page.tsx");
const popup = page.slice(page.indexOf("{open && ("));

test("popup: title, close icon, divider, and the two buttons from the design (Create mode and Edit mode)", () => {
  assert.match(popup, /\{editing \? "Edit Item" : "New Item"\}/);
  assert.match(popup, /aria-label="Close"/);
  assert.match(popup, /<svg[^>]*aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" \/><\/svg>/, "an X icon");
  assert.match(popup, /border-b border-gray-200 px-6 py-4/, "a divider under the title");
  assert.match(popup, /data-testid="item-popup-cancel">Cancel<\/button>/);
  assert.match(popup, /: editing \? "Save changes" : "Create Item"/);
  assert.match(popup, /className="btn-primary px-5 py-2 text-sm font-semibold" data-testid="item-popup-submit"/, "the orange primary button");
});

test("popup: the six fields from the design, in the design's order, with labels above and the right required markers", () => {
  const order = ["Item Name", "Item Code", "Description", ">HSN/SAC <span", "HSN/SAC No", "Unit <span", "Technical details"].map((needle) => popup.indexOf(needle));
  assert.ok(order.every((i) => i > 0), `all found: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "Item Name, Item Code, Description, HSN/SAC, HSN/SAC No, Unit, then the technical details");
  for (const label of ["Item Name", "Item Code", "HSN/SAC", "Unit"]) {
    assert.match(popup, new RegExp(`${label.replace("/", "\\/")} <span className=\\{STAR\\}>\\*</span></label>`), `${label} has a red asterisk`);
  }
  assert.doesNotMatch(popup, />Description <span/, "Description is optional");
  assert.doesNotMatch(popup, />HSN\/SAC No <span/, "HSN/SAC No is optional");
  assert.match(page, /const STAR = "text-red-500";/);
  for (const ph of ["Enter item name", "Enter item code", "Enter description", "Select HSN/SAC", "Enter HSN/SAC No"]) assert.ok(popup.includes(ph), ph);
});

test("popup: HSN/SAC offers exactly HSN and SAC; Unit offers exactly Nos, LTR, MTR, KG, SET; the HSN/SAC number is a free-text input", () => {
  assert.deepEqual(Object.values(HSN_SAC_TYPE), ["HSN", "SAC"]);
  assert.deepEqual(Object.values(PRODUCT_UNIT), ["Nos", "LTR", "MTR", "KG", "SET"]);
  assert.match(page, /const HSN_SAC_OPTIONS = Object\.values\(HSN_SAC_TYPE\);/);
  assert.match(page, /const UNIT_OPTIONS = Object\.values\(PRODUCT_UNIT\);/);
  assert.match(popup, /<option value="">Select Unit \(\{UNIT_OPTIONS\.join\(", "\)\}\)<\/option>/, "the placeholder lists the units, as in the design");
  assert.match(popup, /id="item-hsn-sac-no" maxLength=\{30\} placeholder="Enter HSN\/SAC No"/);
  assert.doesNotMatch(popup.slice(popup.indexOf('id="item-hsn-sac-no"'), popup.indexOf('id="item-hsn-sac-no"') + 200), /pattern=|type="number"|inputMode/, "no number format is enforced");
});

test("popup: required for a NEW item (Item Name, Item Code, HSN/SAC, Unit, and Model as before); an older item can still be edited without the new fields", () => {
  assert.match(popup, /id="item-name" required/);
  assert.match(popup, /id="item-code" required=\{!editing\}/);
  assert.match(popup, /id="item-hsn-sac" required=\{!editing\}/);
  assert.match(popup, /id="item-unit" required=\{!editing\}/);
  assert.match(popup, /id="item-model" required placeholder="Model \(unique\)"/, "Model is still required, unchanged");
  assert.match(page, /if \(!editing && \(!body\.itemCode \|\| !body\.hsnSacType \|\| !body\.unitOfMeasure\)\) \{\s*throw new Error\("Item Code, HSN\/SAC and Unit are required"\);/);
});

test("popup: the new fields are sent to the API (create and edit) and loaded back into the form for editing", () => {
  for (const f of ["itemCode: form.itemCode.trim() || undefined", "description: form.description.trim() || undefined", "hsnSacNo: form.hsnSacNo.trim() || undefined"]) assert.ok(page.includes(f), f);
  assert.match(page, /hsnSacType: \(form\.hsnSacType \|\| undefined\) as "HSN" \| "SAC" \| undefined/);
  assert.match(page, /unitOfMeasure: \(form\.unitOfMeasure \|\| undefined\) as \(typeof UNIT_OPTIONS\)\[number\] \| undefined/);
  for (const f of ["itemCode: p.itemCode ?? \"\"", "description: p.description ?? \"\"", "hsnSacType: p.hsnSacType ?? \"\"", "hsnSacNo: p.hsnSacNo ?? \"\"", "unitOfMeasure: p.unitOfMeasure ?? \"\""]) assert.ok(page.includes(f), f);
  assert.match(page, /await api\(`\/products\/\$\{editing\.id\}`, \{ method: "PUT"/);
  assert.match(page, /await api\("\/products", \{ method: "POST"/);
});

test("popup: the existing Model and technical fields are kept, in a labelled 'Technical details' section (nothing was removed or renamed)", () => {
  const tech = popup.slice(popup.indexOf('data-testid="item-technical-details"'));
  assert.match(tech, /<h4[^>]*>Technical details<\/h4>/);
  for (const needle of ['placeholder="Model (unique)"', 'placeholder="Rating spec (optional)"', 'placeholder="Capacity (kVA)"', 'placeholder="Warranty (months)"', "Shape", 'placeholder="Weight (kg)"', 'placeholder="Dimensions (e.g. 1200 x 600 x 900 mm)"', "Silencer Type"]) {
    assert.ok(tech.includes(needle), needle);
  }
  assert.match(tech, /title="Default duration for new unit warranties\. A unit keeps the duration it was recorded with\."/, "the warranty tooltip is kept");
  assert.match(page, /warrantyMonths: form\.warrantyMonths \? parseInt\(form\.warrantyMonths, 10\) : undefined/, "the default warranty duration is still saved as before");
});

test("popup: exactly the fields we were told about - nothing is built for the three unlabeled boxes in the screenshot", () => {
  const controls = popup.match(/<(input|select|textarea)\b/g) ?? [];
  assert.equal(controls.length, 14, "6 design fields + 8 existing technical fields (Model, Rating spec, Capacity, Warranty, Shape, Weight, Dimensions, Silencer Type)");
});

test("popup: styled here only - the shared modal styling used by other screens is not changed", () => {
  assert.match(popup, /className="modal-panel"\s*style=\{\{ maxWidth: "46rem", padding: 0 \}\}/);
  assert.match(css, /\.modal-panel \{[^}]*max-width: 28rem;[^}]*padding: 1\.25rem;/, "the shared class keeps its width and padding");
  assert.equal(css.includes("46rem"), false, "no wider modal was added to the global CSS");
});

test("list and detail show the new fields; the phone cards show the Item Code; Model stays visible", () => {
  for (const key of ['key: "itemCode"', 'key: "unitOfMeasure"', 'key: "hsnSac"', 'key: "description"']) assert.ok(page.includes(key), key);
  assert.match(page, /key: "model",\s*label: "Model"/);
  assert.match(page, /\{p\.itemCode \? `\$\{p\.itemCode\} · ` : ""\}\{p\.model\}/);
  for (const needle of ["Item code", "product.itemCode", "product.hsnSacType", "product.hsnSacNo", "product.unitOfMeasure", "product.description"]) assert.ok(detail.includes(needle), needle);
  assert.match(detail, /<p className="text-sm text-gray-500 font-mono">\{product\.model\}<\/p>/, "the detail header still shows the model");
});

test("other ways of creating an item are untouched: the Orders form still sends name, model and rating spec, and its rollback is unchanged", () => {
  assert.match(orders, /name: form\.productName,\s*model: form\.productModel,\s*ratingSpec: form\.productRatingSpec \|\| undefined,\s*\}\),/);
  assert.match(orders, /await api\(`\/products\/\$\{createdProductId\}`, \{ method: "DELETE" \}\)/);
  const agent = read("apps/api/src/routes/agentConversations.ts");
  assert.match(agent, /case "create_product": \{[\s\S]{0,200}name: String\(input\.name\),\s*model: String\(input\.model\),/);
});
