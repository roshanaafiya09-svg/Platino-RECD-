import { timingSafeEqual } from "crypto";

/**
 * Shared by every scheduled (Vercel Cron) route. Vercel Cron sends `Authorization: Bearer $CRON_SECRET`; these routes have no user session.
 * Fails closed: an unset or empty CRON_SECRET never matches anything, so a deployment without the secret cannot run any job.
 */
export function isAuthorisedCron(header: string | undefined): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || !header) return false;
  const actual = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${secret}`);
  // Constant-time comparison (the lengths are compared first because timingSafeEqual requires equal lengths).
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * One log line per scheduled run, so the platform's log shows that a job ran and what it did (a run with nothing to do is otherwise silent).
 * Only numbers and booleans are written - never names, e-mail addresses or ids.
 */
export function logCronRun(job: string, startedAt: number, summary: Record<string, unknown>): void {
  const counts: Record<string, number | boolean> = {};
  for (const [key, value] of Object.entries(summary)) {
    if (typeof value === "number" || typeof value === "boolean") counts[key] = value;
  }
  console.log(JSON.stringify({ cron: job, ok: true, ms: Date.now() - startedAt, ...counts }));
}
