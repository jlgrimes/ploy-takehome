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

function describe(e: unknown): { msg: string; retryable: boolean } {
  // fal's ApiError message is often empty over HTTP/2 (it falls back to statusText);
  // the useful detail is in status + body.
  const err = e as { message?: string; status?: number; body?: unknown };
  const detail = err.body ? JSON.stringify(err.body).slice(0, 400) : "";
  const msg = [err.status ? `HTTP ${err.status}` : null, err.message || null, detail || null].filter(Boolean).join(" · ") || String(e);
  // Billing/auth/validation errors won't fix themselves; timeouts and 5xx might.
  const retryable = !err.status || err.status >= 500 || err.status === 429;
  return { msg, retryable };
}

async function runFal(model: string, prompt: string, guideUrl: string) {
  const res = await fal.subscribe(model, { input: toInput(model, prompt, guideUrl) as never, logs: false, startTimeout: 90 });
  const data = res.data as { images?: { url: string }[]; image?: { url: string } };
  const url = data.images?.[0]?.url ?? data.image?.url;
  if (!url) throw new Error("fal returned no image");
  // fal URLs are not durable: download now, caller persists to Storage.
  const dl = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!dl.ok) throw new Error(`download scene: HTTP ${dl.status}`);
  const raw = Buffer.from(await dl.arrayBuffer());
  const bytes = await sharp(raw).resize(W, H, { fit: "cover", position: "centre", kernel: "lanczos3" }).jpeg({ quality: 92 }).toBuffer();
  return { bytes, requestId: res.requestId, url };
}

// When fal is unavailable the ad still ships: the guide's "studio" version (brand-
// toned gradient, the real product as a cutout or rounded photo card, soft shadow).
export async function generateScene(opts: { guideUrl: string; prompt: string; studio: Buffer }): Promise<SceneResult> {
  const t0 = Date.now();
  const key = env.falKey();
  const model = env.sceneModel();
  const fallback = (error: string): SceneResult => ({ bytes: opts.studio, strategy: "studio_fallback", model: key ? model : null, requestId: null, sourceUrl: null, ms: Date.now() - t0, prompt: opts.prompt, error });
  if (!key) return fallback("FAL_KEY not configured");
  fal.config({ credentials: key });
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await runFal(model, opts.prompt, opts.guideUrl);
      return { bytes: r.bytes, strategy: "fal", model, requestId: r.requestId, sourceUrl: r.url, ms: Date.now() - t0, prompt: opts.prompt };
    } catch (e) {
      const { msg, retryable } = describe(e);
      lastError = attempt > 1 ? `${msg} (after retry)` : msg;
      console.error(`fal scene failed (attempt ${attempt}): ${msg}`);
      if (!retryable) break;
    }
  }
  return fallback(lastError);
}
