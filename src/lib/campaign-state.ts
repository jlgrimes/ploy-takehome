import "server-only";
import { db } from "./db";
import type { AdCopy, AngleKey, Brief, Provenance, ResearchStep } from "./types";

// Everything the workspace UI needs, in one round of queries. The client polls this
// while anything is generating; tool results in the chat trigger an immediate refresh.

export type VariantView = {
  id: string;
  version: number;
  status: string;
  changeType: string;
  copy: AdCopy & { sceneDirection?: string };
  renderUrl: string | null;
  sceneUrl: string | null;
  error: string | null;
  gen: Record<string, unknown> | null;
  qa: Record<string, unknown> | null;
  feedback: { text: string; kind: string | null; summary: string | null } | null;
  createdAt: string;
};
export type AdView = {
  id: string;
  angle: AngleKey;
  layout: string;
  status: string;
  approvedVariantId: string | null;
  product: { id: string; title: string; url: string | null; price: number | null } | null;
  variants: VariantView[];
};
export type CampaignState = {
  campaign: { id: string; name: string; status: string; brief: Brief | null; briefConfirmedAt: string | null };
  brand: { id: string; name: string | null; domain: string; platform: string } | null;
  kit: {
    logoUrl: string | null;
    colors: { role: string; hex: string }[];
    fonts: { family: string; url: string | null }[];
    voice: { adjectives: string[]; example: string } | null;
    valueProp: string | null;
    sellingPoints: string[];
    provenance: Record<string, { source: Provenance; detail?: string }>;
  } | null;
  research: { status: string; steps: ResearchStep[] } | null;
  facts: { id: string; kind: string; text: string; productId: string | null; sourceKind: string | null }[];
  products: Record<string, { id: string; title: string; imageUrl: string | null; price: number | null; url: string | null; bestSellerRank: number | null }>;
  ads: AdView[];
};

export async function getCampaignState(campaignId: string): Promise<CampaignState | null> {
  const c = (await db().from("campaigns").select("*").eq("id", campaignId).maybeSingle()).data as
    | { id: string; name: string; status: string; brief: Brief | null; brief_confirmed_at: string | null; brand_id: string }
    | null;
  if (!c) return null;
  const [brandR, kitR, runR, factsR, adsR] = await Promise.all([
    db().from("brands").select("id, name, domain, platform").eq("id", c.brand_id).maybeSingle(),
    db().from("brand_kits").select("*, logo:assets!brand_kits_logo_asset_id_fkey(public_url)").eq("brand_id", c.brand_id).maybeSingle(),
    db().from("research_runs").select("status, steps").eq("brand_id", c.brand_id).order("started_at", { ascending: false }).limit(1),
    db().from("brand_facts").select("id, kind, text, product_id, source_kind").eq("brand_id", c.brand_id),
    db()
      .from("ads")
      .select(
        `id, angle, layout, status, approved_variant_id, position, product_id,
         variants:ad_variants!ad_variants_ad_id_fkey(id, version, status, change_type, copy, error, gen, qa, created_at,
           render:assets!ad_variants_render_asset_id_fkey(public_url),
           scene:assets!ad_variants_scene_asset_id_fkey(public_url),
           fb:feedback!ad_variants_feedback_id_fkey(text, kind, interpretation))`,
      )
      .eq("campaign_id", campaignId)
      .order("position"),
  ]);
  if (adsR.error) console.error("ads query", adsR.error.message);

  // Products referenced by the brief or ads, with one display image each.
  const productIds = [...new Set([...(c.brief?.concepts ?? []).map((x) => x.productId), ...((adsR.data ?? []) as { product_id: string }[]).map((a) => a.product_id)])].filter(Boolean);
  const productsR = productIds.length
    ? await db().from("products").select("id, title, price, url, best_seller_rank, images:product_images(source_url, position, kind, width)").in("id", productIds)
    : { data: [] };
  const products: CampaignState["products"] = {};
  for (const p of (productsR.data ?? []) as { id: string; title: string; price: number | null; url: string | null; best_seller_rank: number | null; images: { source_url: string; position: number | null; width: number | null }[] }[]) {
    const img = [...(p.images ?? [])].sort((a, b) => (a.position ?? 99) - (b.position ?? 99)).find((i) => (i.width ?? 0) >= 600) ?? p.images?.[0];
    products[p.id] = { id: p.id, title: p.title, price: p.price, url: p.url, bestSellerRank: p.best_seller_rank, imageUrl: img ? `${img.source_url}${img.source_url.includes("?") ? "&" : "?"}width=480` : null };
  }

  const kit = kitR.data as Record<string, unknown> | null;
  type RawVariant = { id: string; version: number; status: string; change_type: string; copy: VariantView["copy"]; error: string | null; gen: Record<string, unknown> | null; qa: Record<string, unknown> | null; created_at: string; render: { public_url: string } | null; scene: { public_url: string } | null; fb: { text: string; kind: string | null; interpretation: { summary?: string } | null } | null };
  const ads: AdView[] = ((adsR.data ?? []) as unknown as { id: string; angle: AngleKey; layout: string; status: string; approved_variant_id: string | null; product_id: string; variants: RawVariant[] }[]).map((a) => ({
    id: a.id,
    angle: a.angle,
    layout: a.layout,
    status: a.status,
    approvedVariantId: a.approved_variant_id,
    product: products[a.product_id] ? { id: a.product_id, title: products[a.product_id].title, url: products[a.product_id].url, price: products[a.product_id].price } : null,
    variants: [...(a.variants ?? [])]
      .sort((x, y) => x.version - y.version)
      .map((v) => ({
        id: v.id,
        version: v.version,
        status: v.status,
        changeType: v.change_type,
        copy: v.copy,
        renderUrl: v.render?.public_url ?? null,
        sceneUrl: v.scene?.public_url ?? null,
        error: v.error,
        gen: v.gen,
        qa: v.qa,
        feedback: v.fb ? { text: v.fb.text, kind: v.fb.kind, summary: v.fb.interpretation?.summary ?? null } : null,
        createdAt: v.created_at,
      })),
  }));

  return {
    campaign: { id: c.id, name: c.name, status: c.status, brief: c.brief, briefConfirmedAt: c.brief_confirmed_at },
    brand: (brandR.data as CampaignState["brand"]) ?? null,
    kit: kit
      ? {
          logoUrl: (kit.logo as { public_url: string } | null)?.public_url ?? null,
          colors: (kit.colors as { role: string; hex: string }[]) ?? [],
          fonts: (kit.fonts as { family: string; url: string | null }[]) ?? [],
          voice: (kit.voice as { adjectives: string[]; example: string }) ?? null,
          valueProp: (kit.value_prop as string) ?? null,
          sellingPoints: (kit.selling_points as string[]) ?? [],
          provenance: (kit.provenance as CampaignState["kit"] extends infer K ? K extends { provenance: infer P } ? P : never : never) ?? {},
        }
      : null,
    research: (runR.data?.[0] as CampaignState["research"]) ?? null,
    facts: ((factsR.data ?? []) as { id: string; kind: string; text: string; product_id: string | null; source_kind: string | null }[]).map((f) => ({ id: f.id, kind: f.kind, text: f.text, productId: f.product_id, sourceKind: f.source_kind })),
    products,
    ads,
  };
}
