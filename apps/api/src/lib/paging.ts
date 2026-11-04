import { asOptionalString } from "./params";

/** Largest page a client may ask for. */
export const PAGE_LIMIT_MAX = 500;

export interface Paging {
  take: number;
  skip: number;
}

/**
 * Optional paging for a list route: `?limit=` (1..PAGE_LIMIT_MAX) and `?offset=`. Returns null when no usable `limit` is sent, and the route
 * then answers exactly as it always did (every row) - so existing web and mobile requests are unaffected. An unusable `offset` counts as 0.
 */
export function parsePaging(query: Record<string, unknown>): Paging | null {
  const limit = Number.parseInt(asOptionalString(query.limit as string | undefined) ?? "", 10);
  if (!Number.isInteger(limit) || limit <= 0) return null;
  const offset = Number.parseInt(asOptionalString(query.offset as string | undefined) ?? "", 10);
  return { take: Math.min(limit, PAGE_LIMIT_MAX), skip: Number.isInteger(offset) && offset > 0 ? offset : 0 };
}
