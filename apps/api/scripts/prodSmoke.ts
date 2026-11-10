/**
 * READ-ONLY smoke test of a running Platino API (for example production) with a real login.
 *
 * It signs in once, then only issues GET requests (no ticket, order, customer, report or setting is created or changed). The login itself writes
 * nothing except the normal per-IP rate-limit counter. It sends NO e-mail / WhatsApp message and triggers NO scheduled job.
 *
 * The credentials come from the environment, never from arguments or files in the repository, and are never printed:
 *   PLATINO_API_URL=https://platino-recd.vercel.app PLATINO_SMOKE_EMAIL=<email> PLATINO_SMOKE_PASSWORD=<password> npx tsx scripts/prodSmoke.ts
 * Use a Super Admin or management account to see every screen's data; a lower role is tested for what that role may see.
 */
const base = (process.env.PLATINO_API_URL ?? "").replace(/\/+$/, "");
const email = process.env.PLATINO_SMOKE_EMAIL ?? "";
const password = process.env.PLATINO_SMOKE_PASSWORD ?? "";

if (!base || !email || !password) {
  console.error("Set PLATINO_API_URL, PLATINO_SMOKE_EMAIL and PLATINO_SMOKE_PASSWORD (in the environment, for this one command).");
  process.exit(2);
}

type Row = { check: string; result: "PASS" | "FAIL"; detail: string };
const rows: Row[] = [];
const record = (check: string, ok: boolean, detail: string) => rows.push({ check, result: ok ? "PASS" : "FAIL", detail });

async function get(path: string, token?: string) {
  const res = await fetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, body };
}

async function main() {
  const health = await get("/health");
  record("API health", health.status === 200, `HTTP ${health.status}`);

  const noAuth = await get("/customers");
  record("Protected route refuses a request without a token", noAuth.status === 401, `HTTP ${noAuth.status}`);

  const loginRes = await fetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  const login = (await loginRes.json().catch(() => ({}))) as { token?: string; user?: { role?: string } };
  record("Login", loginRes.status === 200 && !!login.token, `HTTP ${loginRes.status}${login.user?.role ? `, role ${login.user.role}` : ""}`);
  if (!login.token) return;

  const me = await get("/auth/me", login.token);
  const meBody = me.body as { mustChangePassword?: boolean; permissions?: string[] } | null;
  record("Session (/auth/me)", me.status === 200, `HTTP ${me.status}, ${meBody?.permissions?.length ?? 0} permissions${meBody?.mustChangePassword ? ", password change required" : ""}`);
  if (meBody?.mustChangePassword) {
    record("Note", true, "this account must change its password first (do that in the admin site); the data checks below are skipped");
    return;
  }

  for (const [label, path] of [
    ["Settings", "/settings"], ["Dashboard", "/dashboard"], ["Customers list", "/customers"], ["Orders list", "/orders"], ["Products list", "/products"],
    ["Complaints list", "/complaints"], ["RECD units", "/recd-units"], ["Sites", "/sites"], ["AMC orders", "/amc-orders"], ["Service reports", "/service-reports"],
    ["Reminders", "/reminders"], ["Users", "/users"], ["Regions", "/regions"], ["Role list", "/meta/roles"],
  ] as const) {
    const r = await get(path, login.token);
    const count = Array.isArray(r.body) ? `${r.body.length} rows` : "ok";
    record(label, r.status === 200 || r.status === 403, `HTTP ${r.status}${r.status === 200 ? ` (${count})` : " (not permitted for this role)"}`);
  }
}

main()
  .catch((err) => record("Unexpected error", false, String((err as Error).message).slice(0, 160)))
  .finally(() => {
    for (const r of rows) console.log(`${r.result.padEnd(4)}  ${r.check.padEnd(52)} ${r.detail}`);
    const failed = rows.filter((r) => r.result === "FAIL").length;
    console.log(failed ? `\n${failed} check(s) FAILED.` : "\nAll checks passed (read-only; nothing was changed).");
    process.exit(failed ? 1 : 0);
  });
