import "server-only";
import { fal } from "@fal-ai/client";
import sharp from "sharp";
import { AD_HEIGHT as H, AD_WIDTH as W } from "../constants";
import { env } from "../env";
import type { Layout } from "../render/layouts";

// Scene generation on fal. Input is OUR guide canvas (real product already placed,
// quiet zones pre-toned); the model only builds the world around it. It never draws
// text: that's in the prompt, and the QA step checks for invented text afterwards.

export type SceneResult = {
  bytes: Buffer;
  strategy: "fal" | "studio_fallback";
  model: string | null;
  requestId: string | null;
  sourceUrl: string | null;
  ms: number;
  prompt: string;
  error?: string;
};

export function scenePrompt(opts: { direction: string; layout: Layout; isCutout: boolean; productTitle: string; extraFeedback?: string | null }) {
  const product = opts.isCutout
    ? `The product (${opts.productTitle}) is already placed in the image. Keep it EXACTLY as it is: same position, same size, same shape, colors, print and details. Ground it naturally with a soft contact shadow and matching light.`
    : `The center of the image is a real photo of ${opts.productTitle}. Keep that photo EXACTLY as it is and seamlessly extend the scene outward from its edges, matching its lighting, color and perspective.`;
  return [
    `Create a photorealistic, premium vertical 9:16 mobile ad background. ${product}`,
    `Scene: ${opts.direction}.`,
    opts.layout.sceneHint,
    opts.extraFeedback ? `Art direction from the brand: ${opts.extraFeedback}.` : "",
    "Absolutely no text, letters, numbers, words, logos, labels, signage, watermarks or UI anywhere in the image. Do not add any other products.",
  ]
    .filter(Boolean)
    .join(" ");
}

function toInput(model: string, prompt: string, guideUrl: string) {
  if (model.includes("seedream")) return { prompt, image_urls: [guideUrl], image_size: { width: 1440, height: 2560 }, num_images: 1 };
  if (model.includes("kontext")) return { prompt, image_url: guideUrl, aspect_ratio: "9:16", num_images: 1 };
  // nano-banana / gemini image family
  return { prompt, image_urls: [guideUrl], aspect_ratio: "9:16", resolution: "2K", output_format: "jpeg", num_images: 1 };
}

// Graceful degradation when fal is unavailable: the guide itself, softened into a
// clean studio backdrop. The product is still the real photo; the ad still ships.
async function studioFallback(guide: Buffer): Promise<Buffer> {
  const bg = await sharp(guide).blur(40).modulate({ brightness: 1.02 }).toBuffer();
  const vignette = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><radialGradient id="v" cx="50%" cy="48%" r="70%"><stop offset="60%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#000" stop-opacity="0.22"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#v)"/></svg>`,
  );
  return sharp(bg).composite([{ input: vignette }]).jpeg({ quality: 92 }).toBuffer();
}

export async function generateScene(opts: { guide: Buffer; guideUrl: string; prompt: string }): Promise<SceneResult> {
  const t0 = Date.now();
  const key = env.falKey();
  const model = env.sceneModel();
  if (!key) {
    return { bytes: await studioFallback(opts.guide), strategy: "studio_fallback", model: null, requestId: null, sourceUrl: null, ms: Date.now() - t0, prompt: opts.prompt, error: "FAL_KEY not configured" };
  }
  fal.config({ credentials: key });
  try {
    const res = await fal.subscribe(model, { input: toInput(model, opts.prompt, opts.guideUrl) as never, logs: false });
    const data = res.data as { images?: { url: string }[]; image?: { url: string } };
    const url = data.images?.[0]?.url ?? data.image?.url;
    if (!url) throw new Error("fal returned no image");
    // fal URLs are not durable: download now, caller persists to Storage.
    const dl = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!dl.ok) throw new Error(`download scene: HTTP ${dl.status}`);
    const raw = Buffer.from(await dl.arrayBuffer());
    const bytes = await sharp(raw).resize(W, H, { fit: "cover", position: "centre", kernel: "lanczos3" }).jpeg({ quality: 92 }).toBuffer();
    return { bytes, strategy: "fal", model, requestId: res.requestId, sourceUrl: url, ms: Date.now() - t0, prompt: opts.prompt };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("fal scene failed", msg);
    return { bytes: await studioFallback(opts.guide), strategy: "studio_fallback", model, requestId: null, sourceUrl: null, ms: Date.now() - t0, prompt: opts.prompt, error: msg };
  }
}
