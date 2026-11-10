import type { ErrorRequestHandler, RequestHandler } from "express";

/**
 * Request-body problems raised by body-parser (express.json). They are the CALLER's mistake, not a server fault, so they are answered with the
 * matching 4xx and a FIXED message: the parser's own message can quote part of what was sent, so it is never echoed back.
 */
const BODY_PARSER_CLIENT_ERRORS: Record<string, { status: number; message: string }> = {
  "entity.parse.failed": { status: 400, message: "Invalid JSON in request body" },
  "entity.too.large": { status: 413, message: "Request body too large" },
  "encoding.unsupported": { status: 415, message: "Unsupported content encoding" },
  "charset.unsupported": { status: 415, message: "Unsupported character set" },
};

function bodyParserClientError(err: unknown): { status: number; message: string } | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const type = (err as { type?: unknown }).type;
  return typeof type === "string" ? BODY_PARSER_CLIENT_ERRORS[type] : undefined;
}

/**
 * The API's last-resort error handler (Express 5 forwards rejected async handlers here as well, so a downstream failure - like the
 * database being unreachable - returns a clean error response instead of crashing the process).
 *  - A malformed, oversized or wrongly encoded request body is the caller's mistake: 400 / 413 / 415 with a fixed message.
 *  - Everything else is a genuine server error: logged, and answered with a generic 500 that reveals nothing.
 */
export const apiErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) return next(err);
  const clientError = bodyParserClientError(err);
  if (clientError) return res.status(clientError.status).json({ error: clientError.message });
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
};

/** Unknown URLs answer in the same JSON shape as every other error (instead of Express's default HTML page). */
export const apiNotFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: "Not found" });
};
