import "server-only";
import sharp, { type OverlayOptions } from "sharp";
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
  // Deliberate "studio" scene used when the image model is unavailable: brand-toned
  // gradient with the real product (cutout or rounded photo card) and a soft shadow.
  studio: Buffer;
};

// Plain-background cutout. Verified need: Loopy's "Dusty Plum" packshot sits on a
// light lavender studio backdrop, not white; treating it as a full photo pasted a
// lavender box onto the generated scene. So: take the border's median color; if the
// border is uniform, flood-fill pixels close to that color from the edges.
export async function plainBackgroundMask(img: Buffer): Promise<Buffer | null> {
  const { data, info } = await sharp(img).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const borderIdx: number[] = [];
  for (let x = 0; x < w; x++) borderIdx.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) borderIdx.push(y * w, y * w + w - 1);
  const median = (k: number) => borderIdx.map((i) => data[i * 3 + k]).sort((p, q) => p - q)[borderIdx.length >> 1];
  const bgc = [median(0), median(1), median(2)];
  const dist = (i: number) => Math.max(Math.abs(data[i * 3] - bgc[0]), Math.abs(data[i * 3 + 1] - bgc[1]), Math.abs(data[i * 3 + 2] - bgc[2]));
  const uniform = borderIdx.filter((i) => dist(i) <= 22).length / borderIdx.length;
  if (uniform < 0.85) return null; // busy border: a lifestyle photo, keep it whole
  const near = (i: number) => dist(i) <= 26;
  const bg = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (i: number) => {
    if (!bg[i] && near(i)) {
      bg[i] = 1;
      stack.push(i);
    }
  };
  for (const i of borderIdx) push(i);
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    const y = (i / w) | 0;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  // Keep only the product's main shapes. Store packshots often carry small separate
  // graphics (verified on deathwishcoffee.com: Fair Trade / USDA badges beside the
  // box), which the model then scattered around the scene as extra objects.
  const label = new Int32Array(w * h).fill(-1);
  const sizes: number[] = [];
  for (let s0 = 0; s0 < w * h; s0++) {
    if (bg[s0] || label[s0] >= 0) continue;
    const id = sizes.length;
    let size = 0;
    const st = [s0];
    label[s0] = id;
    while (st.length) {
      const i = st.pop()!;
      size++;
      const x = i % w;
      const y = (i / w) | 0;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && !bg[j] && label[j] < 0) {
          label[j] = id;
          st.push(j);
        }
      }
    }
    sizes.push(size);
  }
  const largest = Math.max(0, ...sizes);
  const keep = sizes.map((sz) => sz >= largest * 0.15);
  const alpha = Buffer.alloc(w * h);
  let fg = 0;
  for (let i = 0; i < w * h; i++) {
    const on = !bg[i] && keep[label[i]];
    alpha[i] = on ? 255 : 0;
    if (on) fg++;
  }
  if (fg / (w * h) < 0.05 || fg / (w * h) > 0.92) return null; // nothing or everything left
  // Erode ~2px (JPEG ringing leaves a halo at edges), then soften the edge.
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
  const studio = await buildStudio(fitted.data, productRect, tone, !!rawMask);
  return { buffer, productRect, tone, productMask, studio };
}

async function buildStudio(product: Buffer, rect: Rect, tone: { r: number; g: number; b: number }, isCutout: boolean): Promise<Buffer> {
  const shade = (k: number) => `rgb(${Math.round(tone.r * k)},${Math.round(tone.g * k)},${Math.round(tone.b * k)})`;
  const light = `rgb(${Math.min(255, tone.r + 22)},${Math.min(255, tone.g + 22)},${Math.min(255, tone.b + 22)})`;
  const bg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${light}"/><stop offset="0.55" stop-color="${shade(0.97)}"/><stop offset="1" stop-color="${shade(0.8)}"/></linearGradient><radialGradient id="v" cx="50%" cy="45%" r="75%"><stop offset="0.6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.18"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><rect width="100%" height="100%" fill="url(#v)"/></svg>`,
  );
  const r = 40;
  const layers: OverlayOptions[] = [];
  if (isCutout) {
    // Contact shadow under the product.
    const sw = Math.round(rect.width * 0.8);
    layers.push({
      input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${sw}" height="120"><defs><filter id="b"><feGaussianBlur stdDeviation="18"/></filter></defs><ellipse cx="${sw / 2}" cy="60" rx="${sw / 2 - 30}" ry="22" fill="#000" fill-opacity="0.28" filter="url(#b)"/></svg>`),
      left: rect.left + Math.round((rect.width - sw) / 2),
      top: Math.min(H - 120, rect.top + rect.height - 70),
    });
    layers.push({ input: product, left: rect.left, top: rect.top });
  } else {
    // Photo card: rounded corners + drop shadow, so it reads as intentional.
    const pad = 60;
    layers.push({
      input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${rect.width + pad * 2}" height="${rect.height + pad * 2}"><defs><filter id="b"><feGaussianBlur stdDeviation="22"/></filter></defs><rect x="${pad}" y="${pad + 18}" width="${rect.width}" height="${rect.height}" rx="${r}" fill="#000" fill-opacity="0.32" filter="url(#b)"/></svg>`),
      left: rect.left - pad,
      top: rect.top - pad,
    });
    const rounded = await sharp(product)
      .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${rect.width}" height="${rect.height}"><rect width="${rect.width}" height="${rect.height}" rx="${r}" fill="#fff"/></svg>`), blend: "dest-in" }])
      .png()
      .toBuffer();
    layers.push({ input: rounded, left: rect.left, top: rect.top });
  }
  return sharp(bg).composite(layers).jpeg({ quality: 92 }).toBuffer();
}

// After generation: if the model kept the product where we put it, paste the
// original pixels back so the product is exactly the store's photo. If it moved
// the product (alignment check fails), we don't paste, to avoid a ghosted double.
export async function pasteBackProduct(
  scene: Buffer,
  guide: Buffer,
  rect: Rect,
  productMask: Buffer | null,
  // Our own fallback scene is derived from the guide, so the product cannot have
  // moved; skip the check (blur would otherwise fail it and leave the product soft).
  knownAligned = false,
): Promise<{ buffer: Buffer; aligned: boolean; diff: number; restored: boolean }> {
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
  const aligned = knownAligned || diff < 28;
  if (!aligned) return { buffer: scene, aligned, diff, restored: false };
  // Full lifestyle photo the model already reproduced near-exactly: pasting it back
  // only adds a seam (seen on real output), so keep the model's seamless version.
  if (!productMask && !knownAligned && diff < 14) return { buffer: scene, aligned, diff, restored: false };
  // Lifestyle photo: wide feathered rectangle so the seam blends into the extension
  // (an 18px feather left a visible seam on real fal output). Packshot: the cutout.
  const feather = Math.max(24, Math.round(Math.min(rect.width, rect.height) * 0.07));
  const mask = productMask
    ? productMask
    : await sharp(
        Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${rect.width}" height="${rect.height}"><defs><filter id="f"><feGaussianBlur stdDeviation="${feather / 2}"/></filter></defs><rect x="${feather}" y="${feather}" width="${rect.width - feather * 2}" height="${rect.height - feather * 2}" fill="white" filter="url(#f)"/></svg>`,
        ),
      ).ensureAlpha().extractChannel(3).png().toBuffer();
  let productRgb = await sharp(guide).extract(rect).removeAlpha().png().toBuffer();
  if (!productMask) {
    // The model often shifts white balance slightly around the photo; nudge the
    // original toward the scene's tone (tightly clamped so product colors stay true).
    const [gs, ss] = await Promise.all([sharp(productRgb).stats(), sharp(scene).extract(rect).stats()]);
    const gain = [0, 1, 2].map((k) => Math.min(1.06, Math.max(0.94, (ss.channels[k].stdev || 1) / (gs.channels[k].stdev || 1))));
    const off = [0, 1, 2].map((k) => Math.min(10, Math.max(-10, ss.channels[k].mean - gain[k] * gs.channels[k].mean)));
    productRgb = await sharp(productRgb).linear(gain, off).png().toBuffer();
  }
  const productPixels = await sharp(productRgb).joinChannel(await sharp(mask).resize(rect.width, rect.height).toColourspace("b-w").raw().toBuffer(), { raw: { width: rect.width, height: rect.height, channels: 1 } }).png().toBuffer();
  const buffer = await sharp(scene).composite([{ input: productPixels, left: rect.left, top: rect.top }]).jpeg({ quality: 92 }).toBuffer();
  return { buffer, aligned, diff, restored: true };
}
