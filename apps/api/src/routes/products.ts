import { Router } from "express";
import { createProductSchema, updateProductSchema, PERMISSION_KEY } from "@recd/shared";
import { prisma } from "../lib/prisma";
import { requirePermission, authenticate } from "../middleware/auth";
import { asString } from "../lib/params";

export const productsRouter = Router();
productsRouter.use(authenticate);

const ITEM_CODE_TAKEN = "An item with that Item Code already exists";

/** The item that already uses this Item Code, ignoring case (and `exceptId`, when editing). Item Code is stored trimmed by the schema. */
function itemCodeOwner(itemCode: string, exceptId?: string) {
  return prisma.product.findFirst({
    where: { itemCode: { equals: itemCode, mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
}

/** A unique-index violation raised by the database itself (two people saving the same code or model at the same moment). */
const isUniqueViolation = (err: unknown) => !!err && typeof err === "object" && (err as { code?: unknown }).code === "P2002";

// Read access: anyone who can place an order needs to pick a product.
productsRouter.get("/", requirePermission(PERMISSION_KEY.MANAGE_ORDERS), async (_req, res) => {
  const products = await prisma.product.findMany({ orderBy: { model: "asc" } });
  res.json(products);
});

productsRouter.get("/:id", requirePermission(PERMISSION_KEY.MANAGE_ORDERS), async (req, res) => {
  const id = asString(req.params.id);
  const product = await prisma.product.findUnique({ where: { id } });
  if (!product) return res.status(404).json({ error: "Product not found" });
  res.json(product);
});

productsRouter.post("/", requirePermission(PERMISSION_KEY.MANAGE_ORDERS), async (req, res) => {
  const parsed = createProductSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const modelTaken = await prisma.product.findUnique({ where: { model: parsed.data.model } });
  if (modelTaken) return res.status(400).json({ error: "A product with that model already exists" });

  if (parsed.data.itemCode && (await itemCodeOwner(parsed.data.itemCode))) return res.status(400).json({ error: ITEM_CODE_TAKEN });

  try {
    const product = await prisma.product.create({
      data: {
        name: parsed.data.name,
        model: parsed.data.model,
        ratingSpec: parsed.data.ratingSpec,
        capacityKva: parsed.data.capacityKva,
        warrantyMonths: parsed.data.warrantyMonths,
        shape: parsed.data.shape,
        dimensions: parsed.data.dimensions,
        weightKg: parsed.data.weightKg,
        silencerType: parsed.data.silencerType,
        itemCode: parsed.data.itemCode,
        description: parsed.data.description,
        hsnSacType: parsed.data.hsnSacType,
        hsnSacNo: parsed.data.hsnSacNo,
        unitOfMeasure: parsed.data.unitOfMeasure,
      },
    });
    res.status(201).json(product);
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(400).json({ error: "An item with that Item Code or model already exists" });
    throw err;
  }
});

productsRouter.put("/:id", requirePermission(PERMISSION_KEY.MANAGE_ORDERS), async (req, res) => {
  const id = asString(req.params.id);
  const parsed = updateProductSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const data = parsed.data;

  const existing = await prisma.product.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: "Product not found" });

  if (data.model && data.model !== existing.model) {
    const modelTaken = await prisma.product.findUnique({ where: { model: data.model } });
    if (modelTaken) return res.status(400).json({ error: "A product with that model already exists" });
  }

  if (data.itemCode && (await itemCodeOwner(data.itemCode, id))) return res.status(400).json({ error: ITEM_CODE_TAKEN });

  try {
    const product = await prisma.product.update({
      where: { id },
      data: {
        name: data.name,
        model: data.model,
        ratingSpec: data.ratingSpec,
        capacityKva: data.capacityKva,
        warrantyMonths: data.warrantyMonths,
        shape: data.shape,
        dimensions: data.dimensions,
        weightKg: data.weightKg,
        silencerType: data.silencerType,
        itemCode: data.itemCode,
        description: data.description,
        hsnSacType: data.hsnSacType,
        hsnSacNo: data.hsnSacNo,
        unitOfMeasure: data.unitOfMeasure,
      },
    });
    res.json(product);
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(400).json({ error: "An item with that Item Code or model already exists" });
    throw err;
  }
});

productsRouter.delete("/:id", requirePermission(PERMISSION_KEY.MANAGE_ORDERS), async (req, res) => {
  const id = asString(req.params.id);
  const existing = await prisma.product.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: "Product not found" });

  const [orders, orderLineItems, recdDeliveries] = await Promise.all([
    prisma.order.count({ where: { productId: id } }),
    prisma.orderLineItem.count({ where: { productId: id } }),
    prisma.recdDelivery.count({ where: { productId: id } }),
  ]);
  if (orders > 0 || orderLineItems > 0 || recdDeliveries > 0) {
    return res.status(400).json({
      error: "Cannot delete a product that is used in orders or RECD deliveries",
    });
  }

  await prisma.product.delete({ where: { id } });
  res.status(204).end();
});
