import "server-only";
import sharp from "sharp";
import { AD_HEIGHT as H, AD_WIDTH as W } from "../constants";
import type { Layout, Rect } from "./layouts";

// The guide canvas sent to fal: the real product photo placed where the layout
// wants it, and the quiet zones pre-filled with a soft tone sampled from the photo's
// own edges. Soft gradients, not hard boxes (models read hard boxes as objects
// like signs or posters and draw on them).

export type Guide = {
  buffer: Buffer;
  productRect: Rect;
  tone: { r: number; g: number; b: number };
  // Alpha mask (PNG, rect-sized) of the product's own pixels when the photo is a
  // packshot on a plain light background; null for full-bleed lifestyle photos.
  productMask: Buffer | null;
};

// Plain-background cutout: flood-fill near-white pixels connected to the border.
// Returns null unless the border is overwhelmingly light (i.e. it's a packshot).
export async function plainBackgroundMask(img: Buffer): Promise<Buffer | null> {
  const { data, info } = await sharp(img).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const light = (i: number) => data[i * 3] > 232 && data[i * 3 + 1] > 232 && data[i * 3 + 2] > 232;
  let border = 0, lightBorder = 0;
  for (let x = 0; x < w; x++) for (const y of [0, h - 1]) (border++, light(y * w + x) && lightBorder++);
  for (let y = 0; y < h; y++) for (const x of [0, w - 1]) (border++, light(y * w + x) && lightBorder++);
  if (lightBorder / border < 0.9) return null;
  const bg = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (i: number) => { if (!bg[i] && light(i)) { bg[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) (push(x), push((h - 1) * w + x));
  for (let y = 0; y < h; y++) (push(y * w), push(y * w + w - 1));
  while (stack.length) {
    const i = stack.pop()!; const x = i % w; const y = (i / w) | 0;
    if (x > 0) push(i - 1); if (x < w - 1) push(i + 1); if (y > 0) push(i - w); if (y < h - 1) push(i + w);
  }
  const alpha = Buffer.alloc(w * h);
  let fg = 0;
  for (let i = 0; i < w * h; i++) (alpha[i] = bg[i] ? 0 : 255, fg += bg[i] ? 0 : 1);
  if (fg / (w * h) < 0.05) return null; // nothing left: probably not a packshot
  // Erode ~2px (JPEG ringing leaves a light halo at edges), then soften the edge.
  const eroded = await sharp(alpha, { raw: { width: w, height: h, channels: 1 } }).blur(2).threshold(215).png().toBuffer();
  return sharp(eroded).blur(0.8).png().toBuffer();
}

export async function buildGuide(photo: Buffer, layout: Layout): Promise<Guide> {
  const meta = await sharp(photo).metadata();
  const pw = meta.width ?? 1000;
  const ph = meta.height ?? 1000;
  // Packshot on a plain background: cut the product out and trim to its bounds so
  // the model sees the product itself (not a white card) and it fills its area.
  const rawMask = await plainBackgroundMask(photo);
  let source = photo;
  let tone: { r: number; g: number; b: number };
  if (rawMask) {
    const alpha = await sharp(rawMask).resize(pw, ph).toColourspace("b-w").raw().toBuffer();
    // Separate pipelines: sharp applies removeAlpha after joinChannel within one chain.
    const rgb = await sharp(photo).removeAlpha().png().toBuffer();
    const rgba = await sharp(rgb).joinChannel(alpha, { raw: { width: pw, height: ph, channels: 1 } }).png().toBuffer();
    source = await sharp(rgba).trim({ threshold: 4 }).png().toBuffer();
    // Soft neutral backdrop tinted toward the product so the scene feels related.
    const st = await sharp(source).flatten({ background: "#ffffff" }).stats();
    const mix = (i: number) => Math.round(st.channels[i].mean * 0.18 + 236 * 0.82);
    tone = { r: mix(0), g: mix(1), b: mix(2) };
  } else {
    // Lifestyle photo: continue its own edges (average of top + bottom strips).
    const strip = Math.max(4, Math.round(ph * 0.06));
    const top = await sharp(photo).extract({ left: 0, top: 0, width: pw, height: strip }).stats();
    const bottom = await sharp(photo).extract({ left: 0, top: ph - strip, width: pw, height: strip }).stats();
    const avg = (i: number) => Math.round((top.channels[i].mean + bottom.channels[i].mean) / 2);
    tone = { r: avg(0), g: avg(1), b: avg(2) };
  }

  // Fit inside the product rect (no crop: every product pixel is kept). Cutouts get
  // breathing room so the scene can put a surface/shadow under them.
  const box = rawMask
    ? { width: Math.round(layout.product.width * 0.82), height: Math.round(layout.product.height * 0.86) }
    : { width: layout.product.width, height: layout.product.height };
  const fitted = await sharp(source)
    .resize({ ...box, fit: "inside", withoutEnlargement: false, kernel: "lanczos3" })
    .png()
    .toBuffer({ resolveWithObject: true });
  const productRect: Rect = {
    left: layout.product.left + Math.round((layout.product.width - fitted.info.width) / 2),
    top: layout.product.top + Math.round((layout.product.height - fitted.info.height) / 2),
    width: fitted.info.width,
    height: fitted.info.height,
  };
  const lift = (n: number) => Math.min(255, n + 16);
  const zoneSvg = (z: Rect) =>
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${z.width}" height="${z.height}"><defs><radialGradient id="g" cx="50%" cy="50%" r="75%"><stop offset="0" stop-color="rgb(${lift(tone.r)},${lift(tone.g)},${lift(tone.b)})"/><stop offset="1" stop-color="rgb(${tone.r},${tone.g},${tone.b})"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`,
    );
  const buffer = await sharp({ create: { width: W, height: H, channels: 3, background: tone } })
    .composite([
      ...layout.zones.map((z) => ({ input: zoneSvg(z), left: z.left, top: z.top })),
      { input: fitted.data, left: productRect.left, top: productRect.top },
    ])
    .jpeg({ quality: 92 })
    .toBuffer();
  const productMask = rawMask ? await sharp(fitted.data).ensureAlpha().extractChannel(3).png().toBuffer() : null;
  return { buffer, productRect, tone, productMask };
}

// After generation: if the model kept the product where we put it, paste the
// original pixels back so the product is exactly the store's photo. If it moved
// the product (alignment check fails), we don't paste, to avoid a ghosted double.
export async function pasteBackProduct(
  scene: Buffer,
  guide: Buffer,
  rect: Rect,
  productMask: Buffer | null,
): Promise<{ buffer: Buffer; aligned: boolean; diff: number }> {
  const small = { width: 96, height: Math.max(8, Math.round((96 * rect.height) / rect.width)) };
  const a = await sharp(scene).extract(rect).resize(small).greyscale().raw().toBuffer();
  const b = await sharp(guide).extract(rect).resize(small).greyscale().raw().toBuffer();
  const m = productMask ? await sharp(productMask).resize(small).raw().toBuffer() : null;
  let sum = 0, n = 0;
  for (let i = 0; i < a.length; i++) {
    if (m && m[i] < 128) continue; // compare product pixels only
    sum += Math.abs(a[i] - b[i]);
    n++;
  }
  const diff = n ? sum / n : 255; // mean abs difference, 0-255
  const aligned = diff < 28;
  if (!aligned) return { buffer: scene, aligned, diff };
  // Lifestyle photo: feathered rectangle so the seam blends into the extension.
  // Packshot: the product cutout itself.
  const feather = 18;
  const mask = productMask
    ? productMask
    : await sharp(
        Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${rect.width}" height="${rect.height}"><defs><filter id="f"><feGaussianBlur stdDeviation="${feather / 2}"/></filter></defs><rect x="${feather}" y="${feather}" width="${rect.width - feather * 2}" height="${rect.height - feather * 2}" fill="white" filter="url(#f)"/></svg>`,
        ),
      ).ensureAlpha().extractChannel(3).png().toBuffer();
  const productRgb = await sharp(guide).extract(rect).removeAlpha().png().toBuffer();
  const productPixels = await sharp(productRgb).joinChannel(await sharp(mask).resize(rect.width, rect.height).toColourspace("b-w").raw().toBuffer(), { raw: { width: rect.width, height: rect.height, channels: 1 } }).png().toBuffer();
  const buffer = await sharp(scene).composite([{ input: productPixels, left: rect.left, top: rect.top }]).jpeg({ quality: 92 }).toBuffer();
  return { buffer, aligned, diff };
}
