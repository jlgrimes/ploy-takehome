import type { ShopifyProduct, ShopifyImage } from "./shopify";

// Product picking. Verified failure mode on loopycases.com: the #1 and #2 best
// sellers are finger-loop accessories and #4 is a screen protector. Ranking purely
// by sales would make the first ad about an accessory, so we score against the
// store's dominant product type.

const ACCESSORY = /screen protector|tempered glass|gift card|e-?gift|sample|warranty|insurance|protection plan|replacement|refill|sticker|add[- ]on|shipping|bundle builder|mystery/i;
const MIN_IMAGE_WIDTH = 600; // verified: Loopy's catalog is 720px wide; 800 would reject it all

export type Candidate = {
  product: ShopifyProduct;
  score: number;
  rank: number | null;
  reasons: string[];
  image: ShopifyImage | null;
};

export function tagsOf(p: ShopifyProduct): string[] {
  return Array.isArray(p.tags) ? p.tags : String(p.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);
}

export function dominantType(products: ShopifyProduct[]): string | null {
  const counts = new Map<string, number>();
  for (const p of products) {
    const t = (p.product_type || "").trim().toLowerCase();
    if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return top && top[1] >= Math.max(2, products.length * 0.25) ? top[0] : null;
}

export function imageKind(alt: string | null): "lifestyle" | "packshot" | "unknown" {
  if (!alt) return "unknown";
  if (/\b(holding|wearing|using|hand|woman|man|person|girl|boy|model|on a|in a|lifestyle)\b/i.test(alt)) return "lifestyle";
  if (/^the\s|product shot|front view|back view|packshot/i.test(alt.trim())) return "packshot";
  return "unknown";
}

export function bestImage(p: ShopifyProduct): ShopifyImage | null {
  const usable = (p.images ?? []).filter((i) => (i.width ?? 0) >= MIN_IMAGE_WIDTH);
  if (!usable.length) return null;
  // Prefer the featured image (position 1) unless it's tiny or obviously not the product.
  return usable.find((i) => !/size chart|sizing|packaging|box/i.test(i.alt ?? "")) ?? usable[0];
}

export function scoreProducts(products: ShopifyProduct[], bestSellers: string[], homepageOrder: string[]): Candidate[] {
  const domType = dominantType(products);
  const rankOf = (h: string, list: string[]) => {
    const i = list.indexOf(h);
    return i === -1 ? null : i + 1;
  };
  return products
    .map((p) => {
      const reasons: string[] = [];
      let score = 0;
      const bs = rankOf(p.handle, bestSellers);
      const hp = rankOf(p.handle, homepageOrder);
      if (bs) {
        score += Math.max(0, 60 - (bs - 1) * 4);
        reasons.push(`#${bs} best seller`);
      } else if (hp) {
        score += Math.max(0, 40 - (hp - 1) * 3);
        reasons.push(`Featured on homepage (#${hp})`);
      }
      const available = p.variants?.some((v) => v.available !== false);
      if (!available) score -= 100;
      const image = bestImage(p);
      if (!image) score -= 80;
      else if ((p.images?.length ?? 0) >= 4) score += 5;
      const type = (p.product_type || "").toLowerCase();
      if (domType && type === domType) score += 25;
      else if (domType && type) {
        score -= 20;
        reasons.push(`not a core ${domType} product`);
      }
      if (ACCESSORY.test(`${p.title} ${p.product_type} ${tagsOf(p).join(" ")}`)) score -= 40;
      const v = p.variants?.[0];
      if (v?.compare_at_price && Number(v.compare_at_price) > Number(v.price)) {
        score += 4;
        reasons.push("on sale");
      }
      return { product: p, score, rank: bs, reasons, image };
    })
    .sort((a, b) => b.score - a.score);
}

// Avoid three near-identical picks (same base name / same first word pattern).
export function diverseTop(cands: Candidate[], n: number): Candidate[] {
  const out: Candidate[] = [];
  const base = (t: string) => t.toLowerCase().replace(/\b(case|cases|for|iphone|\d+|pro|max|plus|mini)\b/g, "").split(/\s+/).filter(Boolean)[0] ?? t;
  for (const c of cands) {
    if (c.score < 0) continue;
    if (out.some((o) => base(o.product.title) === base(c.product.title))) continue;
    out.push(c);
    if (out.length === n) break;
  }
  // Tiny catalogs: allow repeats so we still get n concepts (different angles, same product).
  const pool = out.length ? [...out] : cands.slice(0, 1);
  for (let i = 0; out.length < n && pool.length; i++) out.push(pool[i % pool.length]);
  return out;
}
