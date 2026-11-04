import "server-only";
import sharp from "sharp";
import { db, must } from "../db";
import { DEMO_USER_ID } from "../constants";
import { saveAsset } from "../storage";
import type { Brief, BriefConcept, Provenance, ResearchStep } from "../types";
import { fetchText, looksBlocked } from "./fetch";
import {
  detectShopify,
  getBestSellerHandles,
  getProductRating,
  getProducts,
  getShopMeta,
  handlesFromHtml,
  normalizeStoreUrl,
  type ShopifyProduct,
} from "./shopify";
import { cleanBrandName, findColors, findHeadingFont, findLogo, pageBasics } from "./brand";
import { diverseTop, imageKind, scoreProducts, tagsOf } from "./pick";
import { factsFromText, ratingFact, type FactDraft } from "./facts";
import { synthesize } from "./synthesize";
import { productFromPage } from "./generic";

export type ResearchSummary = {
  brandId: string;
  brandName: string;
  domain: string;
  platform: "shopify" | "unknown";
  productCount: number;
  picks: { productId: string; title: string; imageUrl: string | null; angle: string; why: string }[];
  facts: string[];
  missing: string[];
  degraded: string[];
  blocked: boolean;
};

export type ResearchEvent = { steps: ResearchStep[]; done: false } | { steps: ResearchStep[]; done: true; summary: ResearchSummary };

const stripHtml = (s: string | null) => (s ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&amp;/g, " ").replace(/\s+/g, " ").trim();

export async function* runResearch(opts: { campaignId: string; url: string }): AsyncGenerator<ResearchEvent> {
  const target = normalizeStoreUrl(opts.url);
  const steps: ResearchStep[] = [];
  const t0 = Date.now();
  const start = (key: string, label: string) => {
    steps.push({ key, label, status: "running" });
    return Date.now();
  };
  const end = (key: string, status: ResearchStep["status"], detail?: string, since?: number) => {
    const s = steps.find((x) => x.key === key)!;
    Object.assign(s, { status, detail, ms: since ? Date.now() - since : undefined });
  };
  const snap = (): ResearchEvent => ({ steps: steps.map((s) => ({ ...s })), done: false });

  // -- brand row + run log ----------------------------------------------------
  const brand = must(
    await db()
      .from("brands")
      .upsert({ owner_id: DEMO_USER_ID, domain: target.domain, status: "researching", updated_at: new Date().toISOString() }, { onConflict: "owner_id,domain" })
      .select("id")
      .single(),
    "upsert brand",
  ) as { id: string };
  await db().from("campaigns").update({ brand_id: brand.id, status: "researching" }).eq("id", opts.campaignId);
  const run = must(await db().from("research_runs").insert({ brand_id: brand.id }).select("id").single(), "insert run") as { id: string };

  // -- 1. homepage --------------------------------------------------------------
  let t = start("homepage", `Reading ${target.domain}`);
  yield snap();
  const home = await fetchText(target.origin, { timeoutMs: 15_000 });
  const blocked = !home.ok && looksBlocked(home);
  if (home.ok) end("homepage", "ok", `${Math.round(home.text.length / 1024)} KB`, t);
  else end("homepage", "degraded", blocked ? "The store blocked our request (bot protection)" : `HTTP ${home.status || home.error}`, t);
  const shop = home.ok ? detectShopify(home) : { isShopify: false, shopDomain: null };
  const basics = home.ok ? pageBasics(home.text) : { siteName: null, title: null, description: null, ogImage: null, themeColor: null };

  // -- 2. catalog + best sellers (parallel) ------------------------------------
  t = start("catalog", "Pulling the product catalog");
  const t2 = start("bestsellers", "Finding best sellers");
  yield snap();
  const [metaR, prodR, bsR] = await Promise.all([getShopMeta(target.origin), getProducts(target.origin, 2), getBestSellerHandles(target.origin)]);
  let products: ShopifyProduct[] = prodR.products;
  const isShopify = shop.isShopify || products.length > 0;
  if (products.length) end("catalog", "ok", `${products.length} products${metaR.data?.published_products_count && metaR.data.published_products_count > products.length ? ` (of ${metaR.data.published_products_count})` : ""}`, t);
  else end("catalog", "failed", looksBlocked(prodR.res) ? "Catalog is blocked for automated access" : "No public Shopify catalog at this URL", t);

  // Fallback: a pasted product URL works on any platform with schema.org data.
  if (!products.length && target.productHandle !== null) {
    const p = await productFromPage(opts.url);
    if (p) {
      products = [p];
      end("catalog", "degraded", "Used the product page you linked", t);
    }
  }

  const homepageOrder = home.ok ? handlesFromHtml(home.text) : [];
  let bestSellers = bsR.handles.filter((h) => products.some((p) => p.handle === h));
  if (bestSellers.length >= 3) end("bestsellers", "ok", `${bsR.source === "curated" ? "From your Best Sellers collection" : "Top"}: ${bestSellers.slice(0, 3).join(", ")}`, t2);
  else if (homepageOrder.length) {
    bestSellers = [];
    end("bestsellers", "degraded", "No best-seller ranking; using homepage order instead", t2);
  } else end("bestsellers", products.length ? "degraded" : "skipped", "No sales signal; ranking by catalog data", t2);
  yield snap();

  // -- 3. brand kit -------------------------------------------------------------
  t = start("brand", "Reading brand identity");
  yield snap();
  const brandName = cleanBrandName(metaR.data?.name ?? basics.siteName ?? basics.title) ?? target.domain.replace(/^www\./, "").split(".")[0];
  const prov: Record<string, { source: Provenance; detail?: string }> = {};
  const colors = home.ok ? findColors(home.text) : { primary: null, background: null, ink: null, source: "none" };
  const font = home.ok ? findHeadingFont(home.text, target.origin) : null;
  const logo = home.ok ? findLogo(home.text, target.origin, brandName) : null;
  let logoAssetId: string | null = null;
  let logoSourceUrl: string | null = null;
  let logoDominant: string | null = null;
  try {
    let logoPng: Buffer | null = null;
    if (logo?.type === "img") {
      const res = await fetch(logo.url.replace(/([?&])(width|height)=\d+/g, "$1"), { signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        logoPng = await sharp(Buffer.from(await res.arrayBuffer()), { density: 300 }).resize({ height: 240, withoutEnlargement: false }).png().toBuffer();
        logoSourceUrl = logo.url;
      }
    } else if (logo?.type === "svg") {
      const svg = logo.svg.includes("xmlns=") ? logo.svg : logo.svg.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
      logoPng = await sharp(Buffer.from(svg), { density: 300 }).resize({ height: 240 }).png().toBuffer();
      logoSourceUrl = `${target.origin} (inline svg)`;
    }
    if (logoPng) {
      const trimmed = await sharp(logoPng).trim().png().toBuffer().catch(() => logoPng!);
      const asset = await saveAsset({ bytes: trimmed, kind: "logo", brandId: brand.id, path: "logo/logo.png", mime: "image/png", sourceUrl: logoSourceUrl });
      logoAssetId = asset.id;
      const { dominant } = await sharp(trimmed).flatten({ background: "#ffffff" }).stats();
      logoDominant = "#" + [dominant.r, dominant.g, dominant.b].map((n) => n.toString(16).padStart(2, "0")).join("").toUpperCase();
    }
  } catch {
    /* logo is optional; brief card will show "Upload your logo" */
  }
  prov.logo = logoAssetId ? { source: "scraped", detail: logo?.why } : { source: "missing" };
  const isNeutral = (hex: string | null) => {
    if (!hex) return true;
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return Math.max(r, g, b) - Math.min(r, g, b) < 18;
  };
  let primary = colors.primary;
  if (primary) prov.primary = { source: "scraped", detail: colors.source };
  else if (basics.themeColor && !isNeutral(basics.themeColor)) (primary = basics.themeColor.toUpperCase()), (prov.primary = { source: "scraped", detail: "theme-color meta" });
  else if (logoDominant && !isNeutral(logoDominant)) (primary = logoDominant), (prov.primary = { source: "inferred", detail: "dominant logo color" });
  else (primary = "#111111"), (prov.primary = { source: "default" });
  const kitColors = [
    { role: "primary", hex: primary },
    { role: "background", hex: colors.background ?? "#FFFFFF" },
    { role: "ink", hex: colors.ink ?? "#111111" },
  ];
  prov.font = font?.url ? { source: "scraped", detail: font.family } : { source: "default", detail: "Inter" };
  const brandBits = [logoAssetId ? "logo" : null, prov.primary.source !== "default" ? `color ${primary}` : null, font?.url ? `font ${font.family}` : null].filter(Boolean);
  end("brand", brandBits.length >= 2 ? "ok" : "degraded", brandBits.length ? `Found ${brandBits.join(", ")}` : "Couldn't find logo or colors; using defaults", t);
  yield snap();

  // -- 4. score products, ratings ------------------------------------------------
  t = start("products", "Choosing products to feature");
  yield snap();
  const scored = scoreProducts(products, bestSellers, homepageOrder);
  if (target.productHandle) {
    const i = scored.findIndex((c) => c.product.handle === target.productHandle);
    if (i > 0) scored.unshift(...scored.splice(i, 1)); // a pasted product URL always leads
  }
  const shortlist = scored.filter((c) => c.score > -50).slice(0, 8);
  // Verified on liquiddeath.com: top sellers can be unavailable online. We skip them
  // (no point advertising what can't be bought) but say so.
  const soldOutTop = bestSellers
    .slice(0, 5)
    .map((h) => products.find((p) => p.handle === h))
    .filter((p): p is ShopifyProduct => !!p && !p.variants?.some((v) => v.available !== false))
    .map((p) => p.title);
  const ratings = await Promise.all(shortlist.slice(0, 4).map((c) => getProductRating(target.origin, c.product.handle).then((r) => (r ? ratingFact(r, c.product.handle) : null))));
  const facts: FactDraft[] = [...factsFromText(basics.description, "meta_description", target.origin), ...ratings.filter((r): r is FactDraft => !!r)];

  // -- 5. synthesis (LLM), with deterministic fallback --------------------------
  let synth: Awaited<ReturnType<typeof synthesize>> | null = null;
  if (shortlist.length) {
    try {
      synth = await synthesize({
        brandName,
        description: basics.description,
        aboutText: null,
        shortlist: shortlist.map((c) => ({
          handle: c.product.handle,
          title: c.product.title,
          type: c.product.product_type,
          price: c.product.variants?.[0]?.price ?? null,
          why: c.reasons,
          blurb: stripHtml(c.product.body_html).slice(0, 400),
        })),
        facts: facts.map((f) => ({ kind: f.kind, text: f.text })),
      });
      for (const f of synth.extraFacts) facts.push({ kind: f.kind, text: f.text, source_kind: "store_copy", source_url: target.origin });
    } catch (e) {
      console.error("synthesis failed", e);
    }
  }
  const fallbackPicks = diverseTop(shortlist, 3).map((c, i) => ({
    handle: c.product.handle,
    angle: (["benefit", facts.some((f) => f.kind === "rating" || f.kind === "review_count") ? "social_proof" : "lifestyle", "feature"] as const)[i],
    why: c.reasons[0] ?? "Strong product photo",
  }));
  const picks = synth?.picks?.length === 3 ? synth.picks : fallbackPicks;
  const pickedTitles = picks.map((p) => shortlist.find((c) => c.product.handle === p.handle)?.product.title).join(", ");
  if (!shortlist.length) end("products", "failed", "No usable products found", t);
  else if (soldOutTop.length) end("products", "degraded", `Picked ${pickedTitles}. Skipped sold-out best sellers: ${soldOutTop.join(", ")}`, t);
  else end("products", "ok", `Picked ${pickedTitles}`, t);
  yield snap();

  // -- 6. persist -------------------------------------------------------------------
  t = start("save", "Saving brand kit");
  yield snap();
  await db().from("brands").update({ name: brandName, platform: isShopify ? "shopify" : "unknown", shop_domain: shop.shopDomain ?? metaR.data?.myshopify_domain ?? null, currency: metaR.data?.currency ?? null, status: "ready", updated_at: new Date().toISOString() }).eq("id", brand.id);

  // Keep fields the marketer edited; overwrite only what research owns.
  const existing = (await db().from("brand_kits").select("*").eq("brand_id", brand.id).maybeSingle()).data as Record<string, unknown> | null;
  const userEdited = (k: string) => (existing?.provenance as Record<string, { source: string }> | undefined)?.[k]?.source === "user";
  const voice = synth?.voice ?? { adjectives: ["clear", "friendly"], example: basics.description?.split(/[.!]/)[0]?.slice(0, 80) ?? "" };
  prov.voice = synth ? { source: "inferred" } : { source: "default" };
  prov.valueProp = synth ? { source: "inferred" } : basics.description ? { source: "scraped", detail: "meta description" } : { source: "missing" };
  const kitRow = {
    brand_id: brand.id,
    logo_asset_id: userEdited("logo") ? existing?.logo_asset_id : logoAssetId,
    logo_source_url: logoSourceUrl,
    colors: userEdited("primary") ? existing?.colors : kitColors,
    fonts: font ? [{ role: "heading", family: font.family, url: font.url }] : [],
    voice: userEdited("voice") ? existing?.voice : voice,
    value_prop: userEdited("valueProp") ? existing?.value_prop : synth?.valueProp ?? basics.description?.slice(0, 120) ?? null,
    selling_points: synth?.sellingPoints ?? [],
    provenance: { ...prov, ...Object.fromEntries(Object.entries((existing?.provenance as object) ?? {}).filter(([, v]) => (v as { source: string }).source === "user")) },
    updated_at: new Date().toISOString(),
  };
  await db().from("brand_kits").upsert(kitRow, { onConflict: "brand_id" });

  // Products: whole catalog (capped), images only for the shortlist.
  const productRows = products.slice(0, 500).map((p) => ({
    brand_id: brand.id,
    external_id: String(p.id ?? ""),
    handle: p.handle,
    title: p.title,
    description: stripHtml(p.body_html).slice(0, 2000),
    product_type: p.product_type || null,
    vendor: p.vendor || null,
    tags: tagsOf(p).slice(0, 30),
    price: p.variants?.[0]?.price ? Number(p.variants[0].price) : null,
    compare_at_price: p.variants?.[0]?.compare_at_price ? Number(p.variants[0].compare_at_price) : null,
    available: p.variants?.some((v) => v.available !== false) ?? null,
    best_seller_rank: bestSellers.indexOf(p.handle) >= 0 ? bestSellers.indexOf(p.handle) + 1 : null,
    url: `${target.origin}/products/${p.handle}`,
    raw: null,
  }));
  const idByHandle = new Map<string, string>();
  for (let i = 0; i < productRows.length; i += 200) {
    const rows = must(await db().from("products").upsert(productRows.slice(i, i + 200), { onConflict: "brand_id,handle" }).select("id, handle"), "upsert products") as { id: string; handle: string }[];
    rows.forEach((r) => idByHandle.set(r.handle, r.id));
  }
  const imageRows = shortlist.flatMap((c) =>
    (c.product.images ?? []).slice(0, 12).map((img) => ({
      product_id: idByHandle.get(c.product.handle)!,
      source_url: img.src,
      width: img.width,
      height: img.height,
      alt: img.alt,
      position: img.position,
      kind: imageKind(img.alt),
    })),
  ).filter((r) => r.product_id);
  if (imageRows.length) await db().from("product_images").upsert(imageRows, { onConflict: "product_id,source_url" });

  await db().from("brand_facts").delete().eq("brand_id", brand.id).neq("source_kind", "user");
  if (facts.length)
    await db().from("brand_facts").insert(
      facts.map((f) => ({ brand_id: brand.id, product_id: f.product_handle ? idByHandle.get(f.product_handle) ?? null : null, kind: f.kind, text: f.text, value: f.value ?? null, source_url: f.source_url, source_kind: f.source_kind })),
    );

  const concepts: BriefConcept[] = picks
    .map((p) => ({ productId: idByHandle.get(p.handle)!, angle: p.angle, why: p.why }))
    .filter((c) => c.productId);
  const brief: Brief = { concepts, offer: null, voice, valueProp: String(kitRow.value_prop ?? ""), avoid: [], cta: "Shop Now" };
  await db().from("campaigns").update({ brief, status: concepts.length ? "brief_pending" : "draft", name: `${brandName} — first ads`, updated_at: new Date().toISOString() }).eq("id", opts.campaignId);
  end("save", "ok", undefined, t);

  const degraded = steps.filter((s) => s.status === "degraded" || s.status === "failed").map((s) => `${s.label}: ${s.detail}`);
  await db().from("research_runs").update({ status: !concepts.length ? "failed" : degraded.length ? "partial" : "succeeded", steps, finished_at: new Date().toISOString() }).eq("id", run.id);

  const missing = Object.entries(prov).filter(([, v]) => v.source === "missing" || v.source === "default").map(([k]) => k);
  const summary: ResearchSummary = {
    brandId: brand.id,
    brandName,
    domain: target.domain,
    platform: isShopify ? "shopify" : "unknown",
    productCount: products.length,
    picks: concepts.map((c) => {
      const cand = shortlist.find((s) => idByHandle.get(s.product.handle) === c.productId);
      return { productId: c.productId, title: cand?.product.title ?? "", imageUrl: cand?.image?.src ?? null, angle: c.angle, why: c.why };
    }),
    facts: facts.map((f) => f.text),
    missing,
    degraded,
    blocked,
  };
  console.log(`research ${target.domain} done in ${Date.now() - t0}ms`);
  yield { steps: steps.map((s) => ({ ...s })), done: true, summary };
}
