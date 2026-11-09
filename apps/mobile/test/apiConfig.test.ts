// Mobile API address selection: a release build must use the production API and never the development address.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PRODUCTION_API_URL, resolveApiUrl } from "../src/lib/apiConfig";

const appJson = JSON.parse(readFileSync(resolve(__dirname, "..", "app.json"), "utf8"));
const extra = appJson.expo.extra;

test("app.json: apiUrl is the production API (https, not localhost) and devApiUrl is the local one", () => {
  assert.equal(extra.apiUrl, "https://platino-recd.vercel.app");
  assert.equal(extra.apiUrl, PRODUCTION_API_URL);
  assert.equal(extra.devApiUrl, "http://localhost:4000");
});

test("a release build (not dev) uses the production API from app.json", () => {
  assert.equal(resolveApiUrl(extra, false), "https://platino-recd.vercel.app");
});

test("development (expo start) uses the dev address so the app still runs against a local API", () => {
  assert.equal(resolveApiUrl(extra, true), "http://localhost:4000");
});

test("a release build never uses the dev address, even if apiUrl is mis-set to localhost or plain http", () => {
  assert.equal(resolveApiUrl({ apiUrl: "http://localhost:4000", devApiUrl: "http://localhost:4000" }, false), PRODUCTION_API_URL);
  assert.equal(resolveApiUrl({ apiUrl: "http://example.com" }, false), PRODUCTION_API_URL);
  assert.equal(resolveApiUrl({ apiUrl: "not a url" }, false), PRODUCTION_API_URL);
});

test("missing configuration falls back to production, never to localhost", () => {
  assert.equal(resolveApiUrl(undefined, false), PRODUCTION_API_URL);
  assert.equal(resolveApiUrl({}, false), PRODUCTION_API_URL);
  assert.equal(resolveApiUrl({}, true), PRODUCTION_API_URL);
});

test("trailing slashes are removed so request paths join correctly", () => {
  assert.equal(resolveApiUrl({ apiUrl: "https://platino-recd.vercel.app/" }, false), "https://platino-recd.vercel.app");
});
