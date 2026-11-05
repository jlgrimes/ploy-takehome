import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import { AD_HEIGHT as H, AD_WIDTH as W } from "../constants";
import { LAYOUTS, SAFE_BOTTOM, SAFE_TOP, SIDE, type LayoutKey, type Rect } from "./layouts";

// Our text layer. All copy in an ad is drawn here, never by the image model:
// exact brand colors and font, exact spelling, and copy edits re-render in ~1s
// without a new generation.

export type RenderBrand = {
  name: string;
  primary: string;
  ink: string;
  logoPng: Buffer | null;
  font: { family: string; data: Buffer } | null;
};
export type RenderCopy = {
  headline: string;
  subline?: string | null;
  cta: string;
  rating?: { value: number; label: string } | null;
  offer?: string | null;
};

// ---------------------------------------------------------------------------
// fonts
// ---------------------------------------------------------------------------
type SatoriFont = { name: string; data: Buffer; weight: 500 | 700 | 800; style: "normal" };
let inter: SatoriFont[] | null = null;
async function interFonts(): Promise<SatoriFont[]> {
  if (inter) return inter;
  const dir = path.join(process.cwd(), "src/lib/render/fonts");
  inter = await Promise.all(
    ([500, 700, 800] as const).map(async (w) => ({ name: "Inter", data: await readFile(path.join(dir, `inter-${w}.woff`)), weight: w, style: "normal" as const })),
  );
  return inter;
}

// Brand heading font (woff/ttf from the store's @font-face). Falls back to Inter.
const fontCache = new Map<string, Buffer | null>();
export async function loadBrandFont(url: string | null | undefined): Promise<Buffer | null> {
  if (!url) return null;
  if (fontCache.has(url)) return fontCache.get(url)!;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const buf = res.ok ? Buffer.from(await res.arrayBuffer()) : null;
    // woff2 starts with 'wOF2'; satori can't parse it.
    const ok = buf && buf.subarray(0, 4).toString("latin1") !== "wOF2" ? buf : null;
    fontCache.set(url, ok);
    return ok;
  } catch {
    fontCache.set(url, null);
    return null;
  }
}

// ---------------------------------------------------------------------------
// color + legibility
// ---------------------------------------------------------------------------
type RGB = [number, number, number];
export const hexToRgb = (hex: string): RGB => {
  const n = parseInt(hex.replace("#", "").padEnd(6, "0").slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]: RGB) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export const contrast = (a: RGB, b: RGB) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const onColor = (bg: string, ink: string) => (contrast(hexToRgb(bg), [255, 255, 255]) >= contrast(hexToRgb(bg), hexToRgb(ink)) ? "#FFFFFF" : ink);

const TARGET = 4.5; // WCAG AA for text

// Text must clear 4.5:1 against the worst 5% of pixels behind it after the scrim.
// Solve the minimum scrim opacity for white and for ink text; pick the cheaper
// (biased toward white, which reads punchier on photos).
export async function solveLegibility(scene: Buffer, rect: Rect, ink: string) {
  const { data } = await sharp(scene).extract(rect).resize({ width: 270 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const px: RGB[] = [];
  for (let i = 0; i < data.length; i += 3) px.push([data[i], data[i + 1], data[i + 2]]);
  const order = px.map((p, i) => [lum(p), i] as const).sort((a, b) => a[0] - b[0]);
  const solve = (text: RGB, scrim: RGB) => {
    const worst = px[order[Math.floor((lum(text) > 0.5 ? 0.95 : 0.05) * (order.length - 1))][1]];
    for (let a = 0; a <= 0.951; a += 0.05) {
      const blended = worst.map((c, k) => (1 - a) * c + a * scrim[k]) as RGB;
      if (contrast(text, blended) >= TARGET) return +a.toFixed(2);
    }
    return 1;
  };
  const light = solve([255, 255, 255], [0, 0, 0]);
  const dark = solve(hexToRgb(ink), [255, 255, 255]);
  const useLight = light <= dark + 0.15;
  const need = useLight ? light : dark;
  const panel = need > 0.85;
  const alpha = panel ? 0.9 : Math.max(need, 0.15);
  return { text: useLight ? "#FFFFFF" : ink, scrimRgb: useLight ? "0,0,0" : "255,255,255", alpha, panel, need: { light, dark } };
}

// ---------------------------------------------------------------------------
// tree helpers (satori takes React-like element objects)
// ---------------------------------------------------------------------------
type Node = { type: string; props: Record<string, unknown> };
const h = (type: string, style: Record<string, unknown>, ...children: unknown[]): Node => ({
  type,
  props: { style: { display: "flex", ...style }, children: children.flat().filter((c) => c !== null && c !== false && c !== undefined) },
});
const img = (src: string, width: number, height: number, style: Record<string, unknown> = {}): Node => ({ type: "img", props: { src, width, height, style } });
// Keep hyphenated words together (Inter's latin subset has no U+2011, so use a word joiner).
const keepHyphens = (t: string) => t.replace(/(\w)-(\w)/g, "$1-⁠$2");
const fitHeadline = (text: string, maxSize: number, minSize = 64) => {
  const longestWord = Math.max(...text.split(/\s+/).map((w) => w.length));
  const byWord = Math.floor((W - SIDE * 2) / (longestWord * 0.62));
  const byLen = text.length <= 14 ? maxSize : text.length <= 24 ? maxSize * 0.8 : maxSize * 0.66;
  return Math.max(minSize, Math.min(maxSize, byWord, Math.floor(byLen)));
};
const star = (fill: string) =>
  "data:image/svg+xml;base64," +
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="${fill}" d="M12 2l2.9 6.9 7.1.6-5.4 4.7 1.6 7L12 17.3 5.8 21.2l1.6-7L2 9.5l7.1-.6z"/></svg>`).toString("base64");

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------
export async function renderAd(opts: { scene: Buffer; layout: LayoutKey; copy: RenderCopy; brand: RenderBrand }) {
  const scene = await sharp(opts.scene).resize(W, H, { fit: "cover", position: "attention" }).jpeg({ quality: 95 }).toBuffer();
  const L = LAYOUTS[opts.layout];
  const leg = await solveLegibility(scene, L.textRect, opts.brand.ink);
  const scrim = (a = leg.alpha) => `rgba(${leg.scrimRgb},${a})`;
  const fontFamily = opts.brand.font ? "Brand" : "Inter";
  const { copy, brand } = opts;

  const logoNode = (size = 72) => {
    // No logo found: brand name as a wordmark, on the same pill so it reads anywhere.
    if (!brand.logoPng)
      return h("div", { background: "rgba(255,255,255,0.94)", borderRadius: 999, padding: "12px 30px", alignSelf: "flex-start", fontSize: Math.round(size * 0.58), fontWeight: 800, color: brand.ink, letterSpacing: -1, fontFamily }, brand.name);
    // Logos sit on a white pill so dark and colored marks stay readable on any scene.
    return h("div", { background: "rgba(255,255,255,0.94)", borderRadius: 999, padding: "16px 30px", alignSelf: "flex-start" }, img(`data:image/png;base64,${brand.logoPng.toString("base64")}`, logoWidth, size));
  };
  let logoWidth = 0;
  if (brand.logoPng) {
    const m = await sharp(brand.logoPng).metadata();
    logoWidth = Math.min(420, Math.round(((m.width ?? 200) / (m.height ?? 72)) * 72));
  }

  // The button itself must stand out from what's behind it (verified failure: a
  // default #111 button vanished on a dark Liquid Death scene). Measure the area under
  // the button, account for the scrim, and swap to white/ink if contrast is too low.
  const ctaRect = { left: SIDE, top: H - SAFE_BOTTOM - 40 - 132, width: W - SIDE * 2, height: 132 };
  const st = await sharp(scene).extract(ctaRect).stats();
  let behind = [0, 1, 2].map((k) => st.channels[k].mean) as RGB;
  if (opts.layout === "bottomStack") {
    const s0 = leg.scrimRgb.split(",").map(Number);
    const a = leg.panel ? 0.9 : leg.alpha;
    behind = behind.map((c, k) => (1 - a) * c + a * s0[k]) as RGB;
  }
  let ctaBg = brand.primary;
  if (contrast(hexToRgb(ctaBg), behind) < 2.2) ctaBg = lum(behind) < 0.4 ? "#FFFFFF" : brand.ink;
  const cta = h(
    "div",
    { alignSelf: "stretch", justifyContent: "center", alignItems: "center", height: 132, borderRadius: 66, background: ctaBg, color: onColor(ctaBg, brand.ink), fontSize: 48, fontWeight: 700, boxShadow: "0 12px 32px rgba(0,0,0,0.25)" },
    copy.cta,
  );
  const ratingRow = copy.rating
    ? h(
        "div",
        { alignItems: "center", gap: 18 },
        h("div", { gap: 8 }, ...Array.from({ length: 5 }, (_, i) => img(star(i < Math.round(copy.rating!.value) ? "#FFC93C" : leg.text + "55"), 44, 44))),
        h("div", { fontSize: 38, fontWeight: 700, color: leg.text }, copy.rating.label),
      )
    : null;
  const offerBadge = copy.offer
    ? h("div", { alignSelf: "flex-start", background: brand.primary, color: onColor(brand.primary, brand.ink), fontSize: 40, fontWeight: 800, padding: "14px 28px", borderRadius: 20, letterSpacing: -0.5 }, copy.offer)
    : null;
  const headline = (max: number) =>
    h("div", { fontSize: fitHeadline(copy.headline, max), fontWeight: 800, color: leg.text, lineHeight: 1.03, letterSpacing: -2.5, textWrap: "balance", fontFamily }, keepHyphens(copy.headline));
  const subline = copy.subline ? h("div", { fontSize: 42, fontWeight: 500, color: leg.text, opacity: 0.92, lineHeight: 1.25, fontFamily: "Inter" }, copy.subline) : null;

  let tree: Node;
  if (opts.layout === "topHeadline") {
    const block = leg.panel
      ? { flexDirection: "column", marginTop: SAFE_TOP, marginLeft: SIDE - 24, marginRight: SIDE - 24, padding: "40px 44px", gap: 24, borderRadius: 40, background: scrim(0.9) }
      : { flexDirection: "column", paddingTop: SAFE_TOP, paddingLeft: SIDE, paddingRight: SIDE, paddingBottom: 150, gap: 26, backgroundImage: `linear-gradient(to bottom, ${scrim()} 0%, ${scrim()} 72%, rgba(0,0,0,0) 100%)` };
    tree = h(
      "div",
      { width: W, height: H, flexDirection: "column", justifyContent: "space-between", fontFamily: "Inter" },
      h("div", block, logoNode(), offerBadge, headline(128), subline),
      h("div", { flexDirection: "column", paddingLeft: SIDE, paddingRight: SIDE, paddingBottom: SAFE_BOTTOM + 40, paddingTop: 80, backgroundImage: `linear-gradient(to top, rgba(0,0,0,0.28) 0%, rgba(0,0,0,0) 100%)` }, cta),
    );
  } else {
    const block = leg.panel
      ? { flexDirection: "column", gap: 24, marginLeft: SIDE - 24, marginRight: SIDE - 24, marginBottom: SAFE_BOTTOM + 20, padding: "40px 44px", borderRadius: 40, background: scrim(0.9) }
      : { flexDirection: "column", gap: 26, paddingLeft: SIDE, paddingRight: SIDE, paddingBottom: SAFE_BOTTOM + 40, paddingTop: 260, backgroundImage: `linear-gradient(to top, ${scrim()} 0%, ${scrim()} 62%, rgba(0,0,0,0) 100%)` };
    tree = h(
      "div",
      { width: W, height: H, flexDirection: "column", justifyContent: "space-between", fontFamily: "Inter" },
      h("div", { paddingTop: SAFE_TOP, paddingLeft: SIDE }, logoNode(60)),
      h("div", block, offerBadge, ratingRow, headline(112), subline, cta),
    );
  }

  const fonts: { name: string; data: Buffer; weight: 500 | 700 | 800; style: "normal" }[] = [...(await interFonts())];
  if (brand.font) fonts.push({ name: "Brand", data: brand.font.data, weight: 800, style: "normal" });
  const svg = await satori(tree as unknown as React.ReactNode, { width: W, height: H, fonts });
  const overlay = new Resvg(svg, { fitTo: { mode: "width", value: W } }).render().asPng();
  const png = await sharp(scene).composite([{ input: overlay }]).png({ compressionLevel: 8 }).toBuffer();
  const jpg = await sharp(png).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
  return { png, jpg, legibility: { text: leg.text, scrimAlpha: leg.alpha, panel: leg.panel, need: leg.need } };
}
