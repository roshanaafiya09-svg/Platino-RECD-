"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/apiClient";
import { useAuth } from "@/components/AuthContext";
import { DataTable } from "@/components/DataTable";
import { HSN_SAC_TYPE, PRODUCT_UNIT } from "@recd/shared";

interface Product {
  id: string;
  name: string;
  model: string;
  ratingSpec: string | null;
  capacityKva: string | null;
  warrantyMonths: number | null;
  shape: string | null;
  dimensions: string | null;
  weightKg: string | null;
  silencerType: number | null;
  itemCode: string | null;
  description: string | null;
  hsnSacType: string | null;
  hsnSacNo: string | null;
  unitOfMeasure: string | null;
}

// Label styles of the New Item popup (local to this page).
const LABEL = "mb-1 block text-sm font-semibold text-[#0f2a66]";
const STAR = "text-red-500";

const SHAPE_OPTIONS = [
  { value: "", label: "Not set" },
  { value: "cylinder", label: "Cylinder" },
  { value: "triangle", label: "Triangle" },
  { value: "rectangle", label: "Rectangle" },
];

// The HSN/SAC type and the Unit lists come from the shared package (the API validates against the same lists). The HSN/SAC number is free text.
const HSN_SAC_OPTIONS = Object.values(HSN_SAC_TYPE);
const UNIT_OPTIONS = Object.values(PRODUCT_UNIT);

const SILENCER_TYPE_OPTIONS = [
  { value: "", label: "Not set" },
  { value: "1", label: "1" },
  { value: "2", label: "2" },
];

const emptyForm = {
  name: "",
  model: "",
  ratingSpec: "",
  capacityKva: "",
  warrantyMonths: "",
  shape: "",
  dimensions: "",
  weightKg: "",
  silencerType: "",
  itemCode: "",
  description: "",
  hsnSacType: "",
  hsnSacNo: "",
  unitOfMeasure: "",
};

export default function ProductsPage() {
  return (
    <Suspense fallback={null}>
      <ProductsPageInner />
    </Suspense>
  );
}

function ProductsPageInner() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission("manage_orders");
  const searchParams = useSearchParams();
  const editProductId = searchParams.get("edit");

  const [products, setProducts] = useState<Product[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  function load() {
    api<Product[]>("/products")
      .then(setProducts)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load items"));
  }

  useEffect(load, []);

  // Arriving from a product detail page's "Edit" link - open that product's edit modal
  // directly instead of making the user find and click Edit again from the list. Guarded by
  // a ref (not just the effect deps) because saving reloads `products`, which would otherwise
  // re-trigger this effect while `?edit=` is still in the URL and pop the modal back open
  // right after it closes.
  const appliedEditId = useRef<string | null>(null);
  useEffect(() => {
    if (editProductId && editProductId !== appliedEditId.current && products.length > 0) {
      const match = products.find((p) => p.id === editProductId);
      if (match) {
        appliedEditId.current = editProductId;
        openEdit(match);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editProductId, products]);

  function openCreate() {
    setEditing(null);
    setForm(emptyForm);
    setFormError(null);
    setOpen(true);
  }

  function openEdit(p: Product) {
    setEditing(p);
    setForm({
      name: p.name,
      model: p.model,
      ratingSpec: p.ratingSpec ?? "",
      capacityKva: p.capacityKva ?? "",
      warrantyMonths: p.warrantyMonths != null ? String(p.warrantyMonths) : "",
      shape: p.shape ?? "",
      dimensions: p.dimensions ?? "",
      weightKg: p.weightKg ?? "",
      silencerType: p.silencerType != null ? String(p.silencerType) : "",
      itemCode: p.itemCode ?? "",
      description: p.description ?? "",
      hsnSacType: p.hsnSacType ?? "",
      hsnSacNo: p.hsnSacNo ?? "",
      unitOfMeasure: p.unitOfMeasure ?? "",
    });
    setFormError(null);
    setOpen(true);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      const body = {
        name: form.name,
        model: form.model,
        ratingSpec: form.ratingSpec || undefined,
        capacityKva: form.capacityKva ? parseFloat(form.capacityKva) : undefined,
        warrantyMonths: form.warrantyMonths ? parseInt(form.warrantyMonths, 10) : undefined,
        shape: form.shape || undefined,
        dimensions: form.dimensions || undefined,
        weightKg: form.weightKg ? parseFloat(form.weightKg) : undefined,
        silencerType: form.silencerType ? (parseInt(form.silencerType, 10) as 1 | 2) : undefined,
        itemCode: form.itemCode.trim() || undefined,
        description: form.description.trim() || undefined,
        hsnSacType: (form.hsnSacType || undefined) as "HSN" | "SAC" | undefined,
        hsnSacNo: form.hsnSacNo.trim() || undefined,
        unitOfMeasure: (form.unitOfMeasure || undefined) as (typeof UNIT_OPTIONS)[number] | undefined,
      };
      // A NEW item needs its Item Code, HSN/SAC type and Unit (the popup enforces this; the API keeps them optional because the Orders form and the
      // AI assistant also create items). Items created before these fields existed can still be edited without them.
      if (!editing && (!body.itemCode || !body.hsnSacType || !body.unitOfMeasure)) {
        throw new Error("Item Code, HSN/SAC and Unit are required");
      }
      if (editing) {
        await api(`/products/${editing.id}`, { method: "PUT", body: JSON.stringify(body) });
      } else {
        await api("/products", { method: "POST", body: JSON.stringify(body) });
      }
      setOpen(false);
      setEditing(null);
      setForm(emptyForm);
      load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to save item");
    } finally {
      setSaving(false);
    }
  }

  async function remove(p: Product) {
    if (!confirm(`Delete item "${p.name}"? This cannot be undone.`)) return;
    setDeletingId(p.id);
    setDeleteError(null);
    try {
      await api(`/products/${p.id}`, { method: "DELETE" });
      load();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete item");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-6 max-w-5xl" data-testid="products-page">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 print:hidden">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight" style={{ color: "var(--text-heading)" }}>Items</h1>
          <p className="mt-1 text-sm text-gray-500">RECD models used across orders and sites.</p>
        </div>
        {canManage && (
          <button
            data-testid="products-new-button"
            onClick={openCreate}
            className="btn-primary px-4 py-2 text-sm self-start sm:self-auto"
          >
            + New item
          </button>
        )}
      </div>

      {error && <p className="text-sm text-red-600 print:hidden">{error}</p>}
      {deleteError && <p className="text-sm text-red-600">{deleteError}</p>}

      <DataTable
        storageKey="products"
        title="Items"
        rows={products}
        rowKey={(p) => p.id}
        emptyMessage="No items yet."
        columns={[
          {
            key: "name",
            label: "Name",
            accessor: (p) => p.name,
            alwaysVisible: true,
            filterType: "text",
            render: (p) => (
              <Link href={`/products/${p.id}`} className="hover:underline" style={{ color: "var(--theme-primary)" }}>
                {p.name}
              </Link>
            ),
          },
          {
            key: "itemCode",
            label: "Item code",
            accessor: (p) => p.itemCode ?? "",
            filterType: "text",
            render: (p) => <span className="font-mono text-xs">{p.itemCode ?? "-"}</span>,
          },
          {
            key: "model",
            label: "Model",
            accessor: (p) => p.model,
            filterType: "text",
            render: (p) => <span className="font-mono text-xs">{p.model}</span>,
          },
          { key: "unitOfMeasure", label: "Unit", accessor: (p) => p.unitOfMeasure ?? "" },
          { key: "hsnSac", label: "HSN/SAC", accessor: (p) => [p.hsnSacType, p.hsnSacNo].filter(Boolean).join(" "), defaultVisible: false },
          { key: "description", label: "Description", accessor: (p) => p.description ?? "", defaultVisible: false, filterType: "text" },
          { key: "ratingSpec", label: "Rating spec", accessor: (p) => p.ratingSpec ?? "" },
          { key: "capacityKva", label: "Capacity (kVA)", accessor: (p) => p.capacityKva ?? "" },
          { key: "warrantyMonths", label: "Warranty (months)", accessor: (p) => p.warrantyMonths ?? "" },
          { key: "shape", label: "Shape", accessor: (p) => p.shape ?? "", defaultVisible: false },
          { key: "dimensions", label: "Dimensions", accessor: (p) => p.dimensions ?? "", defaultVisible: false, filterType: "text" },
          { key: "weightKg", label: "Weight (kg)", accessor: (p) => p.weightKg ?? "", defaultVisible: false },
          { key: "silencerType", label: "Silencer Type", accessor: (p) => p.silencerType ?? "", defaultVisible: false },
          ...(canManage
            ? [
                {
                  key: "actions",
                  label: "Actions",
                  align: "right" as const,
                  alwaysVisible: true,
                  filterable: false,
                  render: (p: Product) => (
                    <>
                      <button onClick={() => openEdit(p)} className="text-sm font-medium text-blue-600 hover:text-blue-800 mr-3">
                        Edit
                      </button>
                      <button
                        onClick={() => remove(p)}
                        disabled={deletingId === p.id}
                        className="text-sm font-medium text-red-600 hover:text-red-800 disabled:opacity-50"
                      >
                        {deletingId === p.id ? "Deleting…" : "Delete"}
                      </button>
                    </>
                  ),
                },
              ]
            : []),
        ]}
      >
        {(filteredProducts) => (
          <div className="cards-mobile" data-testid="products-mobile-cards">
            {filteredProducts.length === 0 ? (
              <div className="card p-6 text-center text-sm text-gray-400">
                {products.length === 0 ? "No items yet." : "No rows match the current filters."}
              </div>
            ) : (
              filteredProducts.map((p) => (
                <div key={p.id} className="data-card">
                  <Link href={`/products/${p.id}`} className="text-sm font-semibold text-gray-900 truncate block hover:underline">
                    {p.name}
                  </Link>
                  <p className="text-xs text-gray-500 mb-2 font-mono">{p.itemCode ? `${p.itemCode} · ` : ""}{p.model}</p>
                  {p.ratingSpec && (
                    <div className="data-card-row">
                      <span className="label">Rating spec</span>
                      <span className="value">{p.ratingSpec}</span>
                    </div>
                  )}
                  {p.capacityKva && (
                    <div className="data-card-row">
                      <span className="label">Capacity</span>
                      <span className="value">{p.capacityKva} kVA</span>
                    </div>
                  )}
                  {p.warrantyMonths != null && (
                    <div className="data-card-row">
                      <span className="label">Warranty</span>
                      <span className="value">{p.warrantyMonths} months</span>
                    </div>
                  )}
                  {canManage && (
                    <div className="mt-3 flex justify-end gap-4">
                      <button onClick={() => openEdit(p)} className="text-sm font-medium text-blue-600">Edit</button>
                      <button
                        onClick={() => remove(p)}
                        disabled={deletingId === p.id}
                        className="text-sm font-medium text-red-600 disabled:opacity-50"
                      >
                        {deletingId === p.id ? "Deleting…" : "Delete"}
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </DataTable>

      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          {/* Wider than the shared modal and styled here only: the shared .modal-panel class is used by other screens and is not changed. */}
          <div
            className="modal-panel"
            style={{ maxWidth: "46rem", padding: 0 }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="item-popup-title"
            data-testid="item-popup"
          >
            <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
              <h3 id="item-popup-title" className="text-xl font-bold" style={{ color: "#0f2a66" }}>{editing ? "Edit Item" : "New Item"}</h3>
              <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="rounded-md p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700" data-testid="item-popup-close">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>
            <form onSubmit={submit} className="space-y-4 px-6 py-5">
              <div>
                <label htmlFor="item-name" className={LABEL}>Item Name <span className={STAR}>*</span></label>
                <input id="item-name" required placeholder="Enter item name" className="field w-full" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="item-name" />
              </div>
              <div>
                <label htmlFor="item-code" className={LABEL}>Item Code <span className={STAR}>*</span></label>
                <input id="item-code" required={!editing} maxLength={60} placeholder="Enter item code" className="field w-full" value={form.itemCode} onChange={(e) => setForm({ ...form, itemCode: e.target.value })} data-testid="item-code" />
              </div>
              <div>
                <label htmlFor="item-description" className={LABEL}>Description</label>
                <textarea id="item-description" rows={3} maxLength={2000} placeholder="Enter description" className="field w-full" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} data-testid="item-description" />
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="item-hsn-sac" className={LABEL}>HSN/SAC <span className={STAR}>*</span></label>
                  <select id="item-hsn-sac" required={!editing} className="field w-full" value={form.hsnSacType} onChange={(e) => setForm({ ...form, hsnSacType: e.target.value })} data-testid="item-hsn-sac">
                    <option value="">Select HSN/SAC</option>
                    {HSN_SAC_OPTIONS.map((o) => (
                      <option key={o} value={o}>{o}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="item-hsn-sac-no" className={LABEL}>HSN/SAC No</label>
                  <input id="item-hsn-sac-no" maxLength={30} placeholder="Enter HSN/SAC No" className="field w-full" value={form.hsnSacNo} onChange={(e) => setForm({ ...form, hsnSacNo: e.target.value })} data-testid="item-hsn-sac-no" />
                </div>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="item-unit" className={LABEL}>Unit <span className={STAR}>*</span></label>
                  <select id="item-unit" required={!editing} className="field w-full" value={form.unitOfMeasure} onChange={(e) => setForm({ ...form, unitOfMeasure: e.target.value })} data-testid="item-unit">
                    <option value="">Select Unit ({UNIT_OPTIONS.join(", ")})</option>
                    {UNIT_OPTIONS.map((o) => (
                      <option key={o} value={o}>{o}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Existing technical fields stay available (the model, the default warranty and the capacity are used across the platform). */}
              <section className="space-y-3 border-t border-gray-200 pt-4" data-testid="item-technical-details">
                <h4 className="text-sm font-bold" style={{ color: "#0f2a66" }}>Technical details</h4>
                <div>
                  <label htmlFor="item-model" className={LABEL}>Model <span className={STAR}>*</span></label>
                  <input id="item-model" required placeholder="Model (unique)" className="field w-full" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} data-testid="item-model" />
                </div>
                <div>
                  <label htmlFor="item-rating" className={LABEL}>Rating spec</label>
                  <input id="item-rating" placeholder="Rating spec (optional)" className="field w-full" value={form.ratingSpec} onChange={(e) => setForm({ ...form, ratingSpec: e.target.value })} />
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="item-capacity" className={LABEL}>Capacity (kVA)</label>
                    <input id="item-capacity" type="number" min={0} step="0.01" placeholder="Capacity (kVA)" className="field w-full" value={form.capacityKva} onChange={(e) => setForm({ ...form, capacityKva: e.target.value })} />
                  </div>
                  <div>
                    <label htmlFor="item-warranty" className={LABEL}>Warranty (months)</label>
                    <input id="item-warranty" type="number" min={0} placeholder="Warranty (months)" title="Default duration for new unit warranties. A unit keeps the duration it was recorded with." className="field w-full" value={form.warrantyMonths} onChange={(e) => setForm({ ...form, warrantyMonths: e.target.value })} />
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="item-shape" className={LABEL}>Shape</label>
                    <select id="item-shape" className="field w-full" value={form.shape} onChange={(e) => setForm({ ...form, shape: e.target.value })}>
                      {SHAPE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="item-weight" className={LABEL}>Weight (kg)</label>
                    <input id="item-weight" type="number" min={0} step="0.01" placeholder="Weight (kg)" className="field w-full" value={form.weightKg} onChange={(e) => setForm({ ...form, weightKg: e.target.value })} />
                  </div>
                </div>
                <div>
                  <label htmlFor="item-dimensions" className={LABEL}>Dimensions</label>
                  <input id="item-dimensions" placeholder="Dimensions (e.g. 1200 x 600 x 900 mm)" className="field w-full" value={form.dimensions} onChange={(e) => setForm({ ...form, dimensions: e.target.value })} />
                </div>
                <div>
                  <label htmlFor="item-silencer" className={LABEL}>Silencer Type</label>
                  <select id="item-silencer" className="field w-full" value={form.silencerType} onChange={(e) => setForm({ ...form, silencerType: e.target.value })}>
                    {SILENCER_TYPE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
              </section>

              {formError && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2" role="alert" data-testid="item-popup-error">{formError}</p>}

              <div className="flex justify-end gap-3 pt-1">
                <button type="button" onClick={() => setOpen(false)} className="rounded-lg border border-gray-300 px-5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors" data-testid="item-popup-cancel">Cancel</button>
                <button type="submit" disabled={saving} className="btn-primary px-5 py-2 text-sm font-semibold" data-testid="item-popup-submit">
                  {saving ? (editing ? "Saving…" : "Creating…") : editing ? "Save changes" : "Create Item"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
