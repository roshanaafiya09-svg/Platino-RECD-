// Stage 2 of the mobile work: the signature pad and the Sign action on phones. The repo has no component-test runner, so these are source-level checks
// (reading the files as text) plus the pure sizing rules in test/signaturePadSize.test.ts. They prove structure and wiring; they do NOT prove finger input,
// rotation or zoom behaviour - that needs a real iPhone and Android phone (and was looked at in a phone-sized browser separately).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8").replace(/\r\n/g, "\n");
const pad = read("apps/admin-web/src/components/SignaturePad.tsx");
const sign = read("apps/admin-web/src/app/service-reports/[id]/sign/page.tsx");

test("signature pad: laptops and desktops keep the old pad (600 x 200 surface, 3 px lines, the same shape on screen); only phones size themselves", () => {
  assert.match(pad, /width = 600, height = 200/, "the old defaults");
  assert.match(pad, /legacyWidth: width,\s*legacyHeight: height/);
  assert.match(pad, /phone,\n\s*devicePixelRatio/, "the phone flag decides");
  assert.match(pad, /window\.matchMedia\(PHONE_MEDIA_QUERY\)/);
  assert.match(pad, /size\.cssHeight === null \? \{ aspectRatio:/, "no fixed height on laptops and desktops: the old aspect ratio");
  assert.match(pad, /lineWidth: 3 \}/, "the old line width is the starting point");
});

test("signature pad: finger input - pointer events, no page scroll while drawing, one finger at a time, the stroke survives a lost capture", () => {
  for (const handler of ["onPointerDown={start}", "onPointerMove={move}", "onPointerUp={end}", "onPointerCancel={end}", "onLostPointerCapture={end}"]) assert.ok(pad.includes(handler), handler);
  assert.match(pad, /touchAction: "none"/);
  assert.match(pad, /WebkitTouchCallout: "none"/);
  assert.match(pad, /try \{\s*canvasRef\.current\?\.setPointerCapture\(e\.pointerId\);\s*\} catch/);
  assert.match(pad, /if \(activePointer\.current !== null\) return; \/\/ one finger at a time/);
  assert.match(pad, /e\.pointerId !== activePointer\.current/, "only the finger that is drawing moves or ends the stroke");
  assert.match(pad, /ctx\.lineTo\(p\.x \* canvas\.width \+ 0\.01, p\.y \* canvas\.height \+ 0\.01\);/, "a tap still leaves a dot");
});

test("signature pad: rotation and resizing - the pad re-measures, and the signature is redrawn (not lost) when the canvas is replaced", () => {
  assert.match(pad, /new ResizeObserver\(measure\)/);
  assert.match(pad, /addEventListener\("orientationchange", measure\)/);
  assert.match(pad, /observer\.disconnect\(\)/, "cleaned up");
  assert.match(pad, /const strokes = useRef<Pt\[\]\[\]>\(\[\]\)/, "strokes are remembered as shapes");
  assert.match(pad, /\(e\.clientX - rect\.left\) \/ rect\.width/, "points are stored relative to the pad, not in pixels");
  assert.match(pad, /\/\/ Changing a canvas's size clears it: paint the remembered strokes again/);
  assert.match(pad, /useLayoutEffect\(\(\) => \{\s*paintAll\(\);/);
  assert.match(pad, /if \(strokes\.current\.length > 0\) onChange\(exportPng\(\)\)/, "the parent gets the picture at the new size");
  // a stroke in progress ends when the surface is replaced
  assert.match(pad, /activePointer\.current = null;\s*current\.current = null;\s*sizeRef\.current = next;/);
});

test("signature pad: the exported image stays within what the server accepts; the server's own checks are not touched here", () => {
  assert.match(pad, /toDataURL\("image\/png"\)/);
  assert.match(pad, /shrinkScaleFor\(dataUrlBytes\(url\), canvas\.width, canvas\.height\)/);
  assert.match(pad, /onChange\(null\)/, "clearing still reports 'no signature'");
  assert.match(pad, /clearRect/);
  assert.match(pad, /min-h-\[44px\] px-3 font-medium text-\[var\(--theme-accent\)\] disabled:text-gray-400 md:min-h-0 md:px-0/, "a 44px Clear button on phones, the old one on desktops");
});

test("signing screen: the Sign action is always in reach on a phone, without covering anything - and it is the SAME action with the SAME rule", () => {
  // the original button: laptops and desktops only (768px and up), unchanged otherwise
  assert.match(sign, /className="btn-primary hidden px-5 py-3 text-sm font-semibold disabled:opacity-50 md:inline-block" data-testid="sign-and-finalise"/);
  // the phone bar: sticky (in the page flow), not fixed; hidden from 768px up; last thing on the page
  const bar = sign.slice(sign.indexOf('className="sticky bottom-0'), sign.indexOf("</div>\n    </div>\n  );\n}") + 6);
  assert.ok(bar.startsWith('className="sticky bottom-0'), "found the phone bar");
  assert.match(bar, /sticky bottom-0/);
  assert.match(bar, /md:hidden/);
  assert.doesNotMatch(bar, /\bfixed\b/, "a fixed bar would cover the report; a sticky one takes its own space");
  assert.match(bar, /env\(safe-area-inset-bottom\)/, "clear of the home indicator on iPhones");
  assert.match(bar, /min-h-\[48px\] w-full/);
  assert.match(bar, /onClick=\{signNow\} disabled=\{!canSignNow\}/, "the same handler and the same enable rule as the desktop button");
  assert.equal((sign.match(/onClick=\{signNow\}/g) ?? []).length, 2, "exactly two buttons, one per layout");
  assert.equal((sign.match(/const canSignNow =/g) ?? []).length, 1, "one rule decides both");
  assert.match(sign, /sign-bar-hint/);
  for (const hint of ["Type your full name", "Draw your signature in the box", "Tick the approval box", "Ready to sign"]) assert.ok(sign.includes(`"${hint}"`), hint);
});

test("signing screen: bigger tap targets on phones (44px+, a 24px tick box), the desktop sizes unchanged", () => {
  assert.match(sign, /className="mt-1 h-6 w-6 shrink-0 md:h-auto md:w-auto"/);
  assert.match(sign, /className="flex min-h-\[44px\] items-start gap-2 text-sm text-gray-700 md:min-h-0"/);
  assert.match(sign, /inline-flex min-h-\[44px\] items-center px-4 underline md:min-h-0 md:px-0/, "the staff cancel control");
  assert.match(sign, /btn-primary px-5 py-3 text-sm font-semibold/, "the start-signing button was already 44px");
  assert.match(sign, /px-4 py-3 text-sm disabled:opacity-50 md:py-2/, "the download buttons");
});

test("signing screen: the approval flow and what is sent to the server are unchanged", () => {
  assert.match(sign, /useState<Stage>\("handoff"\)/);
  assert.match(sign, /body: JSON\.stringify\(\{ signerName, signatureImage, version: report\.version, confirm: true, signingSession: session \}\)/);
  assert.match(sign, /const canSignNow = !!signatureImage && signerName\.trim\(\)\.length >= SERVICE_REPORT_LIMITS\.SIGNER_NAME_MIN && confirm && busy === null;/);
  assert.match(sign, /I have reviewed this report and approve it\./);
  assert.match(sign, /<SignaturePad onChange=\{setSignatureImage\} disabled=\{busy === "sign"\} \/>/);
  assert.doesNotMatch(sign, /useAuth|user\?\.name/, "the signer's name is still never taken from the staff login");
});
