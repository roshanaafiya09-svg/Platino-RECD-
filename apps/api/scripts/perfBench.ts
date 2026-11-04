/**
 * Local before/after timing of the endpoints behind the main admin screens, against the DISPOSABLE test database only.
 *
 * It refuses to run unless DATABASE_URL points at localhost:5434/platino_test. It only reads (GET requests) and counts the SQL
 * statements each request issues (counted on the database connection). To mimic the network distance between the Vercel function and the
 * hosted database it can send the database traffic through a small delaying proxy: BENCH_DB_DELAY_MS is the one-way delay.
 *
 * Run: BENCH_DB_DELAY_MS=3 npx tsx scripts/perfBench.ts   (from apps/api, with DATABASE_URL / DIRECT_URL / JWT_SECRET set)
 */
import "dotenv/config";
import net from "node:net";
import crypto from "node:crypto";

const raw = process.env.DATABASE_URL ?? "";
const url = new URL(raw || "postgresql://invalid");
if (!(["localhost", "127.0.0.1"].includes(url.hostname) && url.port === "5434" && url.pathname === "/platino_test")) {
  console.error("Refusing to run: DATABASE_URL is not the disposable localhost:5434/platino_test database.");
  process.exit(1);
}

const delayMs = Number(process.env.BENCH_DB_DELAY_MS ?? 0);
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 40);

/** Counts the statements the app sends: every Sync ('S') or simple Query ('Q') message in the client -> server stream. */
let statements = 0;
function makeCounter() {
  let buf = Buffer.alloc(0);
  let started = false;
  return (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (!started) {
        if (buf.length < 8) return;
        const len = buf.readInt32BE(0);
        const code = buf.readInt32BE(4);
        if (code === 80877103) { buf = buf.subarray(8); continue; } // SSLRequest: the real startup follows
        if (buf.length < len) return;
        buf = buf.subarray(len);
        started = true;
        continue;
      }
      if (buf.length < 5) return;
      const len = buf.readInt32BE(1);
      if (buf.length < 1 + len) return;
      if (buf[0] === 0x53 /* S */ || buf[0] === 0x51 /* Q */) statements += 1;
      buf = buf.subarray(1 + len);
    }
  };
}

/** Passes database traffic through, counting statements and (optionally) delaying every chunk to mimic network distance. */
function startProxy(listenPort: number, targetPort: number, oneWayMs: number) {
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, "127.0.0.1");
    const count = makeCounter();
    const pipe = (from: net.Socket, to: net.Socket, counts: boolean) => {
      from.on("data", (chunk) => {
        if (counts) count(chunk);
        if (oneWayMs > 0) setTimeout(() => !to.destroyed && to.write(chunk), oneWayMs);
        else to.write(chunk);
      });
      from.on("close", () => setTimeout(() => to.destroy(), oneWayMs + 5));
      from.on("error", () => to.destroy());
    };
    pipe(client, upstream, true);
    pipe(upstream, client, false);
  });
  return new Promise<void>((resolve) => server.listen(listenPort, "127.0.0.1", resolve));
}

async function main() {
  await startProxy(5439, 5434, delayMs);
  url.port = "5439";
  process.env.DATABASE_URL = url.toString();
  process.env.PORT = "4123";
  const { default: app } = await import("../src/index");
  const { signToken } = await import("../src/lib/jwt");
  const { prisma } = await import("../src/lib/prisma");
  void app;
  // BENCH_FORCE_QUERY_STRATEGY=1 makes every query use the one-statement-per-relation strategy, to prove the responses are byte-identical either way.
  if (process.env.BENCH_FORCE_QUERY_STRATEGY) {
    (prisma as any).$use(async (params: any, next: any) => {
      if (params.args && typeof params.args === "object" && ("include" in params.args || "select" in params.args)) params.args.relationLoadStrategy = "query";
      return next(params);
    });
  }

  const who = async (email: string) => {
    const u = await prisma.user.findFirstOrThrow({ where: { email }, include: { role: true } });
    return signToken({ userId: u.id, roleKey: u.role.key, customerId: u.customerId, tokenVersion: u.tokenVersion });
  };
  const tokens = { super_admin: await who("superadmin@platino.example"), customer: await who("customer@sundaram.example") };
  const base = "http://127.0.0.1:4123";

  const cases: [string, string, keyof typeof tokens][] = [
    ["auth/me", "/auth/me", "super_admin"],
    ["settings", "/settings", "super_admin"],
    ["dashboard", "/dashboard", "super_admin"],
    ["complaints (staff)", "/complaints", "super_admin"],
    ["customers", "/customers", "super_admin"],
    ["recd-units", "/recd-units", "super_admin"],
    ["amc-orders", "/amc-orders", "super_admin"],
    ["service-reports", "/service-reports", "super_admin"],
    ["sites", "/sites", "super_admin"],
  ];
  const rows: string[] = [];
  for (const [label, path, role] of cases) {
    const hit = () => fetch(base + path, { headers: { Authorization: `Bearer ${tokens[role]}` } });
    const first = await hit(); // warm-up (also builds Prisma's connection)
    const body = Buffer.from(await first.arrayBuffer());
    const bytes = body.byteLength;
    const digest = crypto.createHash("sha1").update(body).digest("hex").slice(0, 10);
    statements = 0;
    const times: number[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      const t = performance.now();
      const res = await hit();
      await res.arrayBuffer();
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    const p = (q: number) => times[Math.min(times.length - 1, Math.floor(times.length * q))].toFixed(1);
    rows.push(`${label.padEnd(20)} status ${first.status}  sql/req ${(statements / ROUNDS).toFixed(1).padStart(5)}  p50 ${p(0.5).padStart(7)} ms  p95 ${p(0.95).padStart(7)} ms  ${String(bytes).padStart(8)} bytes  sha1 ${digest}`);
  }
  console.log(`\nBENCH db one-way delay ${delayMs} ms, ${ROUNDS} requests each`);
  for (const r of rows) console.log(r);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
