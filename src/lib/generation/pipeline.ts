import "server-only";
import sharp from "sharp";
import { db, must } from "../db";
import { saveAsset } from "../storage";
import { buildGuide, pasteBackProduct } from "../render/guide";
import { LAYOUTS, layoutForAngle, type LayoutKey } from "../render/layouts";
import { loadBrandFont, renderAd, type RenderBrand } from "../render/text-layer";
import type { AdCopy, AngleKey, Brief } from "../types";
import { writeCopy, type CopyDraft, type Fact } from "./copy";
import { checkScene } from "./qa";
import { generateScene, scenePrompt } from "./scene";
import { planFeedback } from "./feedback";

// ---------------------------------------------------------------------------
// Context loading
// ---------------------------------------------------------------------------
type ProductRow = { id: string; title: string; description: string | null; product_type: string | null; price: number | null; brand_id: string };
type ImageRow = { id: string; source_url: string; width: number | null; height: number | null; alt: string | null; kind: string; position: number | null; asset_id: string | null };
type VariantRow = {
  id: string;
  version: number;
  copy: CopyDraft;
  scene_asset_id: string | null;
  guide_asset_id: string | null;
  reference_image_id: string | null;
  status: string;
};

async function bytesOf(url: string) {
  const r = await fetch(url, { signal: AbortSignal.timeout(30_000), cache: "no-store" });
  if (!r.ok) throw new Error(`fetch ${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function loadAdContext(adId: string) {
  const ad = must(await db().from("ads").select("*").eq("id", adId).single(), "load ad") as { id: string; campaign_id: string; product_id: string; angle: AngleKey; layout: LayoutKey };
  const campaign = must(await db().from("campaigns").select("*").eq("id", ad.campaign_id).single(), "load campaign") as { id: string; brand_id: string; brief: Brief };
  const [brandR, kitR, productR, imagesR, factsR] = await Promise.all([
    db().from("brands").select("*").eq("id", campaign.brand_id).single(),
    db().from("brand_kits").select("*, logo:assets!brand_kits_logo_asset_id_fkey(public_url)").eq("brand_id", campaign.brand_id).maybeSingle(),
    db().from("products").select("id, title, description, product_type, price, brand_id").eq("id", ad.product_id).single(),
    db().from("product_images").select("*").eq("product_id", ad.product_id).order("position"),
    db().from("brand_facts").select("id, kind, text, product_id").eq("brand_id", campaign.brand_id),
  ]);
  const brand = must(brandR, "load brand") as { id: string; name: string };
  const kit = kitR.data as { colors: { role: string; hex: string }[]; fonts: { family: string; url: string | null }[]; logo: { public_url: string } | null } | null;
  const product = must(productR, "load product") as ProductRow;
  const images = (imagesR.data ?? []) as ImageRow[];
  // Facts: brand-wide + this product's (other products' ratings would be misleading).
  const facts = ((factsR.data ?? []) as Fact[]).filter((f) => !f.product_id || f.product_id === product.id);
  return { ad, campaign, brand, kit, product, images, facts };
}

const brandCache = new Map<string, { at: number; value: RenderBrand }>();
async function renderBrand(ctx: Awaited<ReturnType<typeof loadAdContext>>): Promise<RenderBrand> {
  const hit = brandCache.get(ctx.brand.id);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const color = (role: string, d: string) => ctx.kit?.colors?.find((c) => c.role === role)?.hex ?? d;
  const fontUrl = ctx.kit?.fonts?.[0]?.url ?? null;
  const [logoPng, fontData] = await Promise.all([
    ctx.kit?.logo?.public_url ? bytesOf(ctx.kit.logo.public_url).catch(() => null) : Promise.resolve(null),
    loadBrandFont(fontUrl),
  ]);
  const value: RenderBrand = {
    name: ctx.brand.name,
    primary: color("primary", "#111111"),
    ink: color("ink", "#111111"),
    logoPng,
    font: fontData ? { family: ctx.kit!.fonts[0].family, data: fontData } : null,
  };
  brandCache.set(ctx.brand.id, { at: Date.now(), value });
  return value;
}

// Reference photo choice: lifestyle photos for lifestyle/social-proof angles (we
// extend the brand's own photo), plain packshots for benefit/feature angles.
function chooseReference(images: ImageRow[], angle: AngleKey, avoidId?: string | null): ImageRow | null {
  const usable = images.filter((i) => (i.width ?? 0) >= 600 && i.id !== avoidId);
  if (!usable.length) return images[0] ?? null;
  const want = angle === "lifestyle" || angle === "social_proof" || angle === "gift" ? "lifestyle" : "packshot";
  return usable.find((i) => i.kind === want) ?? usable[0];
}

async function referenceBytes(img: ImageRow, brandId: string, productId: string): Promise<Buffer> {
  if (img.asset_id) {
    const a = (await db().from("assets").select("public_url").eq("id", img.asset_id).single()).data as { public_url: string } | null;
    if (a) return bytesOf(a.public_url);
  }
  // Copy the store image into Storage once; later versions reuse it.
  const raw = await bytesOf(img.source_url);
  const bytes = await sharp(raw).rotate().jpeg({ quality: 94 }).toBuffer();
  const asset = await saveAsset({ bytes, kind: "product_image", brandId, path: `products/${productId}/${img.id}.jpg`, mime: "image/jpeg", sourceUrl: img.source_url });
  await db().from("product_images").update({ asset_id: asset.id }).eq("id", img.id);
  return bytes;
}

function ratingFor(copy: AdCopy, facts: Fact[]) {
  if (!copy.showRating) return null;
  const f = facts.find((x) => copy.factIds.includes(x.id) && (x.kind === "rating" || x.kind === "review_count"));
  if (!f) return null;
  const value = Number(f.text.match(/(\d\.\d)\s*stars?/i)?.[1] ?? 5);
  return { value, label: f.text };
}

// ---------------------------------------------------------------------------
// One version of one ad
// ---------------------------------------------------------------------------
export type VariantStatus = "queued" | "generating_scene" | "rendering" | "ready" | "failed";

export async function generateVariant(opts: {
  adId: string;
  changeType: "initial" | "copy_edit" | "scene_regen" | "brief_change";
  parent?: VariantRow | null;
  feedbackId?: string | null;
  instruction?: string | null; // copy instruction from feedback
  sceneInstruction?: string | null;
  copyOverride?: AdCopy | null; // manual edit from the UI
  rewriteCopy: boolean;
  reuseScene: boolean;
  onStatus?: (s: VariantStatus, detail?: string) => void;
}) {
  const ctx = await loadAdContext(opts.adId);
  const last = (await db().from("ad_variants").select("version").eq("ad_id", opts.adId).order("version", { ascending: false }).limit(1)).data?.[0] as { version: number } | undefined;
  const variant = must(
    await db()
      .from("ad_variants")
      .insert({ ad_id: opts.adId, version: (last?.version ?? 0) + 1, parent_variant_id: opts.parent?.id ?? null, change_type: opts.changeType, feedback_id: opts.feedbackId ?? null, copy: opts.parent?.copy ?? {}, status: "queued" })
      .select("id, version")
      .single(),
    "insert variant",
  ) as { id: string; version: number };
  await db().from("ads").update({ status: "generating", updated_at: new Date().toISOString() }).eq("id", opts.adId);
  const setStatus = async (status: VariantStatus, detail?: string) => {
    opts.onStatus?.(status, detail);
    await db().from("ad_variants").update({ status, updated_at: new Date().toISOString() }).eq("id", variant.id);
  };

  try {
    const layout = LAYOUTS[ctx.ad.layout] ?? LAYOUTS[layoutForAngle(ctx.ad.angle)];
    const brand = await renderBrand(ctx);

    // 1. copy
    let copy: CopyDraft;
    if (opts.copyOverride) copy = { ...opts.copyOverride, sceneDirection: opts.parent?.copy?.sceneDirection ?? "" };
    else if (opts.rewriteCopy || !opts.parent) {
      opts.onStatus?.("queued", "Writing copy");
      copy = await writeCopy({
        brandName: ctx.brand.name,
        brief: ctx.campaign.brief,
        angle: ctx.ad.angle,
        product: ctx.product,
        facts: ctx.facts,
        previous: opts.parent?.copy ?? null,
        instruction: opts.instruction,
        keepScene: opts.reuseScene,
      });
    } else copy = opts.parent.copy;
    await db().from("ad_variants").update({ copy }).eq("id", variant.id);

    // 2. scene (reuse for copy-only changes)
    let sceneBytes: Buffer;
    let sceneAssetId: string | null = null;
    let guideAssetId: string | null = opts.parent?.guide_asset_id ?? null;
    let referenceId: string | null = opts.parent?.reference_image_id ?? null;
    let gen: Record<string, unknown> = {};
    let qa: Record<string, unknown> | null = null;
    if (opts.reuseScene && opts.parent?.scene_asset_id) {
      const a = (await db().from("assets").select("id, public_url").eq("id", opts.parent.scene_asset_id).single()).data as { id: string; public_url: string };
      sceneBytes = await bytesOf(a.public_url);
      sceneAssetId = a.id;
      gen = { strategy: "reused_scene", fromVariant: opts.parent.id };
    } else {
      await setStatus("generating_scene");
      const ref = (opts.parent?.reference_image_id && ctx.images.find((i) => i.id === opts.parent!.reference_image_id)) || chooseReference(ctx.images, ctx.ad.angle);
      if (!ref) throw new Error("This product has no usable photos.");
      referenceId = ref.id;
      const original = await referenceBytes(ref, ctx.brand.id, ctx.product.id);
      const guide = await buildGuide(original, layout);
      const base = `ads/${opts.adId}/${variant.id}`;
      const guideAsset = await saveAsset({ bytes: guide.buffer, kind: "guide", brandId: ctx.brand.id, path: `${base}/guide.jpg`, mime: "image/jpeg" });
      guideAssetId = guideAsset.id;
      const prompt = scenePrompt({ direction: copy.sceneDirection || "a clean, softly lit studio set in the brand's colors", layout, isCutout: !!guide.productMask, productTitle: ctx.product.title, extraFeedback: opts.sceneInstruction });
      let scene = await generateScene({ guide: guide.buffer, guideUrl: guideAsset.public_url, prompt });
      let pasted = await pasteBackProduct(scene.bytes, guide.buffer, guide.productRect, guide.productMask);
      let check = await checkScene({ original, scene: pasted.buffer, zonesHint: layout.sceneHint, productPixelsPasted: pasted.aligned });
      // One retry if the model invented text or lost the product.
      if (scene.strategy === "fal" && (check.inventedText || !check.productMatches)) {
        const retryPrompt = `${prompt} IMPORTANT: the previous attempt ${check.inventedText ? "added text or lettering" : "changed the product"}; do not.`;
        const second = await generateScene({ guide: guide.buffer, guideUrl: guideAsset.public_url, prompt: retryPrompt });
        const pasted2 = await pasteBackProduct(second.bytes, guide.buffer, guide.productRect, guide.productMask);
        const check2 = await checkScene({ original, scene: pasted2.buffer, zonesHint: layout.sceneHint, productPixelsPasted: pasted2.aligned });
        if ((!check2.inventedText && check2.productMatches) || check.inventedText) (scene = second), (pasted = pasted2), (check = check2);
      }
      sceneBytes = pasted.buffer;
      const sceneAsset = await saveAsset({ bytes: sceneBytes, kind: "scene", brandId: ctx.brand.id, path: `${base}/scene.jpg`, mime: "image/jpeg", sourceUrl: scene.sourceUrl });
      sceneAssetId = sceneAsset.id;
      gen = { strategy: scene.strategy, model: scene.model, falRequestId: scene.requestId, ms: scene.ms, prompt: scene.prompt, error: scene.error ?? null, cutout: !!guide.productMask, pasteBack: { aligned: pasted.aligned, diff: Math.round(pasted.diff) } };
      qa = check;
    }

    // 3. text layer
    await setStatus("rendering");
    const rendered = await renderAd({
      scene: sceneBytes,
      layout: layout.key,
      copy: { headline: copy.headline, subline: copy.subline, cta: copy.cta, rating: ratingFor(copy, ctx.facts), offer: ctx.campaign.brief.offer },
      brand,
    });
    const renderAsset = await saveAsset({ bytes: rendered.jpg, kind: "render", brandId: ctx.brand.id, path: `ads/${opts.adId}/${variant.id}/ad.jpg`, mime: "image/jpeg" });
    await db()
      .from("ad_variants")
      .update({
        status: "ready",
        scene_asset_id: sceneAssetId,
        guide_asset_id: guideAssetId,
        render_asset_id: renderAsset.id,
        reference_image_id: referenceId,
        gen: { ...gen, legibility: rendered.legibility },
        qa: qa ?? (opts.parent ? undefined : null),
        updated_at: new Date().toISOString(),
      })
      .eq("id", variant.id);
    await db().from("ads").update({ status: "needs_review", updated_at: new Date().toISOString() }).eq("id", opts.adId);
    opts.onStatus?.("ready");
    return { variantId: variant.id, version: variant.version, renderUrl: renderAsset.public_url, copy };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("variant failed", opts.adId, msg);
    await db().from("ad_variants").update({ status: "failed", error: msg.slice(0, 500), updated_at: new Date().toISOString() }).eq("id", variant.id);
    // Keep the ad reviewable if an earlier version exists.
    await db().from("ads").update({ status: opts.parent ? "needs_review" : "failed", updated_at: new Date().toISOString() }).eq("id", opts.adId);
    opts.onStatus?.("failed", msg);
    return { variantId: variant.id, version: variant.version, renderUrl: null, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Campaign-level operations (used by agent tools and API routes)
// ---------------------------------------------------------------------------
export type AdProgress = { adId: string; title: string; angle: AngleKey; status: VariantStatus; detail?: string; renderUrl?: string | null; headline?: string };

// Turn a callback-style job into an async iterable of progress snapshots.
export function progressStream<T>(run: (emit: (v: T) => void) => Promise<void>): AsyncIterable<T> {
  const queue: T[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  let error: unknown = null;
  run((v) => {
    queue.push(v);
    wake?.();
  })
    .catch((e) => (error = e))
    .finally(() => {
      done = true;
      wake?.();
    });
  return {
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length) {
          yield queue.shift()!;
          continue;
        }
        if (done) break;
        await new Promise<void>((r) => (wake = r));
        wake = null;
      }
      if (error) throw error;
    },
  };
}

export async function* generateCampaignAds(campaignId: string): AsyncGenerator<AdProgress[]> {
  const campaign = must(await db().from("campaigns").select("*").eq("id", campaignId).single(), "load campaign") as { id: string; brief: Brief };
  if (!campaign.brief?.concepts?.length) throw new Error("No confirmed brief to generate from.");
  let ads = ((await db().from("ads").select("id, product_id, angle, position").eq("campaign_id", campaignId).order("position")).data ?? []) as { id: string; product_id: string; angle: AngleKey; position: number }[];
  if (!ads.length) {
    ads = must(
      await db()
        .from("ads")
        .insert(campaign.brief.concepts.map((c, i) => ({ campaign_id: campaignId, product_id: c.productId, angle: c.angle, layout: layoutForAngle(c.angle), position: i, status: "pending" })))
        .select("id, product_id, angle, position"),
      "insert ads",
    ) as typeof ads;
  }
  await db().from("campaigns").update({ status: "generating", updated_at: new Date().toISOString() }).eq("id", campaignId);
  const titles = new Map(((await db().from("products").select("id, title").in("id", ads.map((a) => a.product_id))).data ?? []).map((p: { id: string; title: string }) => [p.id, p.title]));
  const state: AdProgress[] = ads.map((a) => ({ adId: a.id, title: titles.get(a.product_id) ?? "", angle: a.angle, status: "queued" }));
  yield state.map((s) => ({ ...s }));

  for await (const snapshot of progressStream<AdProgress[]>(async (emit) => {
    await Promise.all(
      ads.map(async (a, i) => {
        const res = await generateVariant({
          adId: a.id,
          changeType: "initial",
          rewriteCopy: true,
          reuseScene: false,
          onStatus: (status, detail) => {
            state[i] = { ...state[i], status, detail };
            emit(state.map((s) => ({ ...s })));
          },
        });
        state[i] = { ...state[i], status: res.renderUrl ? "ready" : "failed", renderUrl: res.renderUrl, headline: "copy" in res ? res.copy?.headline : undefined, detail: "error" in res ? res.error : undefined };
        emit(state.map((s) => ({ ...s })));
      }),
    );
  }))
    yield snapshot;

  await db().from("campaigns").update({ status: "in_review", updated_at: new Date().toISOString() }).eq("id", campaignId);
}

async function latestVariant(adId: string, variantId?: string | null) {
  let q = db().from("ad_variants").select("id, version, copy, scene_asset_id, guide_asset_id, reference_image_id, status").eq("ad_id", adId);
  q = variantId ? q.eq("id", variantId) : q.eq("status", "ready").order("version", { ascending: false }).limit(1);
  return ((await q).data?.[0] ?? null) as VariantRow | null;
}

export async function* reviseAd(opts: { adId: string; feedback: string; variantId?: string | null }): AsyncGenerator<{ status: string; plan?: unknown; result?: unknown }> {
  const current = await latestVariant(opts.adId, opts.variantId);
  if (!current) throw new Error("This ad has no finished version to revise yet.");
  yield { status: "Reading your feedback" };
  const plan = await planFeedback({ feedback: opts.feedback, current: current.copy });
  const fb = must(
    await db().from("feedback").insert({ ad_id: opts.adId, variant_id: current.id, text: opts.feedback, kind: plan.kind, interpretation: plan }).select("id").single(),
    "insert feedback",
  ) as { id: string };
  yield { status: plan.kind === "copy" ? "Rewriting copy (keeping the image)" : plan.kind === "scene" ? "Generating a new scene" : "Updating the brand brief", plan };

  if (plan.kind === "brief" && plan.briefChange) {
    const ad = must(await db().from("ads").select("campaign_id").eq("id", opts.adId).single(), "ad") as { campaign_id: string };
    const c = must(await db().from("campaigns").select("brief").eq("id", ad.campaign_id).single(), "campaign") as { brief: Brief };
    const brief: Brief = {
      ...c.brief,
      avoid: [...new Set([...(c.brief.avoid ?? []), ...plan.briefChange.addAvoid])],
      voice: plan.briefChange.voiceAdjectives?.length ? { ...c.brief.voice, adjectives: plan.briefChange.voiceAdjectives } : c.brief.voice,
    };
    await db().from("campaigns").update({ brief, updated_at: new Date().toISOString() }).eq("id", ad.campaign_id);
  }
  const isScene = plan.kind === "scene";
  const res = await generateVariant({
    adId: opts.adId,
    changeType: plan.kind === "copy" ? "copy_edit" : isScene ? "scene_regen" : "brief_change",
    parent: current,
    feedbackId: fb.id,
    instruction: plan.copyInstruction ?? (plan.kind !== "scene" ? opts.feedback : null),
    sceneInstruction: isScene ? plan.sceneInstruction ?? opts.feedback : null,
    rewriteCopy: !isScene || plan.alsoChangeCopy,
    reuseScene: !isScene,
  });
  await db().from("feedback").update({ result_variant_id: res.variantId }).eq("id", fb.id);
  yield { status: res.renderUrl ? "ready" : "failed", plan, result: res };
}

export async function editCopy(opts: { adId: string; copy: AdCopy; variantId?: string | null }) {
  const current = await latestVariant(opts.adId, opts.variantId);
  if (!current) throw new Error("No version to edit.");
  const fb = must(
    await db().from("feedback").insert({ ad_id: opts.adId, variant_id: current.id, text: "Edited the copy directly", kind: "copy", interpretation: { manual: true, summary: "Manual copy edit", copy: opts.copy } }).select("id").single(),
    "insert feedback",
  ) as { id: string };
  const res = await generateVariant({ adId: opts.adId, changeType: "copy_edit", parent: current, feedbackId: fb.id, copyOverride: { ...opts.copy, factIds: current.copy.factIds ?? [], showRating: current.copy.showRating }, rewriteCopy: false, reuseScene: true });
  await db().from("feedback").update({ result_variant_id: res.variantId }).eq("id", fb.id);
  return res;
}
