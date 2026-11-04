// Local smoke test for the render pipeline (no network): guide -> fake scene -> paste-back -> text layer.
// Run: node --conditions=react-server --import tsx scripts/render-smoke.mts <dir-with-coffee.png>
import sharp from "sharp";
import { readFile, writeFile } from "node:fs/promises";
import { buildGuide, pasteBackProduct } from "../src/lib/render/guide";
import { LAYOUTS } from "../src/lib/render/layouts";
import { renderAd } from "../src/lib/render/text-layer";

const dir = process.argv[2];
const out = process.argv[3] ?? ".";
// Synthetic packshot: a "phone case" on white.
const packshot = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="720" height="960"><rect width="720" height="960" fill="#ffffff"/><rect x="210" y="130" width="300" height="620" rx="54" fill="#c8a27a"/><circle cx="300" cy="230" r="46" fill="#3b2a1e"/><path d="M260 520 q100 -60 200 0" stroke="#7a4f2c" stroke-width="18" fill="none"/></svg>`)).jpeg().toBuffer();
const lifestyle = await readFile(`${dir}/coffee.png`);
const brand = { name: "Loopy", primary: "#166534", ink: "#1F2A21", logoPng: null, font: null };

for (const [name, photo, layout, copy] of [
  ["packshot-top", packshot, "topHeadline", { headline: "Stop the drop.", subline: "The finger-loop case you'll never let go of.", cta: "Shop Now", offer: null }],
  ["lifestyle-bottom", lifestyle, "bottomStack", { headline: "Never drop your phone again", cta: "Get Yours", rating: { value: 4.9, label: "70,000+ five-star reviews" } }],
] as const) {
  const L = LAYOUTS[layout];
  const guide = await buildGuide(photo, L);
  // Fake "model output": guide with zones darkened + noise, product left in place.
  const fakeScene = await sharp(guide.buffer).modulate({ brightness: 0.9, saturation: 1.2 }).blur(2).toBuffer();
  const pasted = await pasteBackProduct(fakeScene, guide.buffer, guide.productRect, guide.productMask);
  const r = await renderAd({ scene: pasted.buffer, layout, copy, brand });
  await writeFile(`${out}/smoke-${name}-guide.jpg`, guide.buffer);
  await writeFile(`${out}/smoke-${name}.jpg`, r.jpg);
  console.log(name, { mask: !!guide.productMask, aligned: pasted.aligned, diff: pasted.diff.toFixed(1), legibility: r.legibility });
}
