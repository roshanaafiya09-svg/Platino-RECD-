-- Item catalogue fields for the redesigned "New Item" popup: Item Code, Description, HSN/SAC type, HSN/SAC number and Unit of measure.
--
-- ADDITIVE and safe for existing data:
--   * five NEW, NULLABLE columns on "Product"; no column is renamed, changed or dropped, and no row is touched;
--   * "model" (unique) and every other existing column keep working exactly as before - Item Code is a separate field, not a rename of model;
--   * one new unique index makes Item Code unique ignoring upper/lower case. Rows without an Item Code (every existing row) are unaffected: NULLs are
--     never equal to each other, so any number of items may have none.
-- The HSN/SAC type and the Unit are checked by the API (HSN | SAC; Nos | LTR | MTR | KG | SET); the database keeps plain text so the list can grow
-- without a migration. The HSN/SAC number is free text.

ALTER TABLE "Product" ADD COLUMN "itemCode" TEXT;
ALTER TABLE "Product" ADD COLUMN "description" TEXT;
ALTER TABLE "Product" ADD COLUMN "hsnSacType" TEXT;
ALTER TABLE "Product" ADD COLUMN "hsnSacNo" TEXT;
ALTER TABLE "Product" ADD COLUMN "unitOfMeasure" TEXT;

CREATE UNIQUE INDEX "Product_itemCode_lower_key" ON "Product" (lower("itemCode"));
