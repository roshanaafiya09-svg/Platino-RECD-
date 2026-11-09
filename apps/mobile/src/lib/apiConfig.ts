// Which API the app talks to. Kept free of React Native imports so it can be unit-tested with plain Node.
//
// app.json -> expo.extra holds the two addresses:
//   apiUrl     the PRODUCTION API (used by every release / store / preview build)
//   devApiUrl  the address used only while developing (`expo start`, where __DEV__ is true), e.g. a local API
// A release build can therefore never use the development address, even if it is mis-set.

export const PRODUCTION_API_URL = "https://platino-recd.vercel.app";

type ApiExtra = { apiUrl?: unknown; devApiUrl?: unknown } | null | undefined;

const clean = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim().replace(/\/+$/, "") : undefined);

/** A production address must be https and must not point at this machine. */
function isUsableProductionUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !["localhost", "127.0.0.1", "::1", "[::1]", "10.0.2.2"].includes(u.hostname);
  } catch {
    return false;
  }
}

export function resolveApiUrl(extra: ApiExtra, isDev: boolean): string {
  const configured = clean(extra?.apiUrl);
  const production = configured && isUsableProductionUrl(configured) ? configured : PRODUCTION_API_URL;
  if (!isDev) return production;
  return clean(extra?.devApiUrl) ?? production;
}
