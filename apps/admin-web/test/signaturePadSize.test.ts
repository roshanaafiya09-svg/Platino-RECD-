// The signature pad's sizing rules (src/lib/signaturePadSize.ts): pure functions, no browser needed.
import test from "node:test";
import assert from "node:assert/strict";
import { SERVICE_REPORT_LIMITS } from "@recd/shared";
import { PAD_MAX_BYTES, PHONE_PAD_MAX_HEIGHT, PHONE_PAD_MIN_HEIGHT, computePadSize, dataUrlBytes, shrinkScaleFor } from "../src/lib/signaturePadSize";

const base = { devicePixelRatio: 2, viewportHeight: 812, legacyWidth: 600, legacyHeight: 200 };
const L = SERVICE_REPORT_LIMITS;

test("laptops and desktops: exactly the old pad - a fixed 600 x 200 surface, the same shape on screen, 3px lines - whatever the screen density", () => {
  for (const dpr of [1, 1.25, 2, 3]) {
    for (const w of [320, 600, 672, 1000]) {
      assert.deepEqual(computePadSize({ ...base, containerWidth: w, phone: false, devicePixelRatio: dpr }), { canvasWidth: 600, canvasHeight: 200, cssHeight: null, lineWidth: 3 });
    }
  }
  // an unknown width also falls back to the old pad
  assert.equal(computePadSize({ ...base, containerWidth: 0, phone: true }).canvasWidth, 600);
  assert.equal(computePadSize({ ...base, containerWidth: NaN, phone: true }).cssHeight, null);
});

test("phones: a taller pad (about 200px on a 375px phone), drawn at the screen density with a thicker line", () => {
  const s = computePadSize({ ...base, containerWidth: 311, phone: true });
  assert.equal(s.cssHeight, 193 > PHONE_PAD_MIN_HEIGHT ? 193 : PHONE_PAD_MIN_HEIGHT);
  assert.ok(s.cssHeight! >= PHONE_PAD_MIN_HEIGHT && s.cssHeight! <= PHONE_PAD_MAX_HEIGHT);
  assert.deepEqual([s.canvasWidth, s.canvasHeight], [622, 386], "2x density");
  assert.equal(s.lineWidth, 7, "3.5 css px at 2x");
  const old = 103; // the old pad's height on a 375px phone
  assert.ok(s.cssHeight! > old * 1.7, "much taller than before");
});

test("phones: always within what the server accepts (80..1600 px a side), for any screen density and width", () => {
  for (const w of [100, 150, 280, 311, 360, 480, 640, 767, 1500, 4000]) {
    for (const dpr of [0.5, 1, 1.5, 2, 2.625, 3, 5]) {
      for (const vh of [300, 568, 740, 812, 1024]) {
        const s = computePadSize({ ...base, containerWidth: w, phone: true, devicePixelRatio: dpr, viewportHeight: vh });
        assert.ok(s.canvasWidth >= L.SIGNATURE_MIN_DIMENSION && s.canvasWidth <= L.SIGNATURE_MAX_DIMENSION, `w=${w} dpr=${dpr} -> ${s.canvasWidth}`);
        assert.ok(s.canvasHeight >= L.SIGNATURE_MIN_DIMENSION && s.canvasHeight <= L.SIGNATURE_MAX_DIMENSION, `w=${w} dpr=${dpr} vh=${vh} -> ${s.canvasHeight}`);
        assert.ok(s.cssHeight! >= PHONE_PAD_MIN_HEIGHT && s.cssHeight! <= PHONE_PAD_MAX_HEIGHT);
        assert.ok(s.lineWidth > 0);
      }
    }
  }
});

test("phones: the pad never takes more than about 45% of a short screen (the Sign button must stay visible), but never gets smaller than 180px", () => {
  assert.equal(computePadSize({ ...base, containerWidth: 700, phone: true, viewportHeight: 1000 }).cssHeight, PHONE_PAD_MAX_HEIGHT);
  assert.equal(computePadSize({ ...base, containerWidth: 700, phone: true, viewportHeight: 500 }).cssHeight, 225);
  assert.equal(computePadSize({ ...base, containerWidth: 700, phone: true, viewportHeight: 300 }).cssHeight, PHONE_PAD_MIN_HEIGHT);
});

test("data URL size and the shrink rule keep a busy signature under the pad's own ceiling (80% of the server's limit)", () => {
  assert.equal(dataUrlBytes("data:image/png;base64,AAAA"), 3);
  assert.equal(dataUrlBytes("data:image/png;base64,AAA="), 2);
  assert.equal(dataUrlBytes("data:image/png;base64,AA=="), 1);
  assert.equal(PAD_MAX_BYTES, Math.floor(L.SIGNATURE_MAX_BYTES * 0.8));
  assert.equal(shrinkScaleFor(50_000, 622, 386), 1, "a normal signature is exported as drawn");
  assert.equal(shrinkScaleFor(PAD_MAX_BYTES, 622, 386), 1);
  const scale = shrinkScaleFor(PAD_MAX_BYTES * 3, 622, 386);
  assert.ok(scale < 1 && scale >= 0.25);
  assert.ok(Math.min(622, 386) * scale >= L.SIGNATURE_MIN_DIMENSION, "never below the server's minimum side");
  // a small pad is never shrunk below the minimum side
  assert.equal(shrinkScaleFor(10_000_000, 90, 90), 1);
});
