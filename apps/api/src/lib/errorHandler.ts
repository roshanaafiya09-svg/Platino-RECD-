import type { ErrorRequestHandler } from "express";

/** body-parser (express.json) tags a body that is not valid JSON with this type and status 400. */
function isMalformedJsonBody(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { type?: unknown }).type === "entity.parse.failed";
}

/**
 * The API's last-resort error handler (Express 5 forwards rejected async handlers here as well, so a downstream failure - like the
 * database being unreachable - returns a clean error response instead of crashing the process).
 *  - A request body that is not valid JSON is the CALLER's mistake: 400, with a fixed message (the parser's own message can quote part
 *    of the body, so it is never echoed).
 *  - Everything else is a genuine server error: logged, and answered with a generic 500 that reveals nothing.
 */
export const apiErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) return next(err);
  if (isMalformedJsonBody(err)) {
    return res.status(400).json({ error: "Invalid JSON in request body" });
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
};
