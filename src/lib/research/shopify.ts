import "server-only";
import { fetchJson, fetchText, looksBlocked, type FetchResult } from "./fetch";

// ---------------------------------------------------------------------------
// URL handling
// ---------------------------------------------------------------------------
export type StoreTarget = { origin: string; domain: string; productHandle: string | null };

export function normalizeStoreUrl(input: string): StoreTarget {
  let raw = input.trim();
  if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;
  const u = new URL(raw);
  if (!u.hostname.includes(".")) throw new Error("That doesn't look like a store URL.");
  const handle = u.pathname.match(/\/products\/([a-z0-9\-_%]+)/i)?.[1] ?? null;
  return { origin: `https://${u.hostname}`, domain: u.hostname.toLowerCase(), productHandle: handle };
}

// ---------------------------------------------------------------------------
// Shopify storefront endpoints (all public, no API key)
// ---------------------------------------------------------------------------
export type ShopifyImage = { id: number; src: string; width: number; height: number; alt: string | null; position: number };
export type ShopifyVariant = { id: number; price: string; compare_at_price: string | null; available?: boolean };
export type ShopifyProduct = {
  id: number;
  title: string;
  handle: string;
  body_html: string | null;
  vendor: string;
  product_type: string;
  tags: string[] | string;
  variants: ShopifyVariant[];
  images: ShopifyImage[];
};

export type ShopMeta = { name?: string; description?: string; currency?: string; myshopify_domain?: string; published_products_count?: number };

export function detectShopify(home: FetchResult): { isShopify: boolean; shopDomain: string | null } {
  const h = home.text;
  const header = home.headers?.get("powered-by") ?? "";
  const isShopify = /shopify/i.test(header) || h.includes("cdn.shopify.com") || /window\.Shopify\b|Shopify\.shop\s*=/.test(h);
  const shopDomain = h.match(/Shopify\.shop\s*=\s*"([^"]+)"/)?.[1] ?? null;
  return { isShopify, shopDomain };
}

export async function getShopMeta(origin: string) {
  return fetchJson<ShopMeta>(`${origin}/meta.json`);
}

// /products.json pages at 250. Verified: page=N works, past-the-end returns [].
export async function getProducts(origin: string, maxPages = 2) {
  const all: ShopifyProduct[] = [];
  let last: FetchResult | null = null;
  for (let page = 1; page <= maxPages; page++) {
    const { data, res } = await fetchJson<{ products: ShopifyProduct[] }>(`${origin}/products.json?limit=250&page=${page}`, 15_000);
    last = res;
    if (!data?.products?.length) break;
    all.push(...data.products);
    if (data.products.length < 250) break;
  }
  return { products: all, res: last! };
}

// Ordered product handles found in links on a page (dedup, first occurrence wins).
export function handlesFromHtml(html: string): string[] {
  const out: string[] = [];
  const re = /href="(?:https?:\/\/[^"/]+)?(?:\/collections\/[^"/]+)?\/products\/([a-z0-9\-_%]+)/gi;
  for (const m of html.matchAll(re)) {
    const h = decodeURIComponent(m[1]).toLowerCase();
    if (!out.includes(h)) out.push(h);
  }
  return out;
}

// Verified: the JSON endpoint ignores sort_by, so best-seller order must come from
// the rendered collection page. Works on most themes; JS-rendered grids (verified on
// allbirds.com) return nothing, so we fall back to merchant-curated best-seller
// collections, whose JSON keeps the merchant's manual order.
const CURATED = ["best-sellers", "bestsellers", "best-seller", "bestseller", "top-sellers", "best-selling"];
export async function getBestSellerHandles(origin: string): Promise<{ handles: string[]; source: "sorted" | "curated" | "none"; res: FetchResult }> {
  const res = await fetchText(`${origin}/collections/all?sort_by=best-selling`);
  const handles = res.ok ? handlesFromHtml(res.text) : [];
  if (handles.length >= 3) return { handles, source: "sorted", res };
  for (const c of CURATED) {
    const { data } = await fetchJson<{ products: ShopifyProduct[] }>(`${origin}/collections/${c}/products.json?limit=30`, 8000);
    if (data?.products?.length && data.products.length >= 3) return { handles: data.products.map((p) => p.handle), source: "curated", res };
  }
  return { handles, source: "none", res };
}

// Per-product structured data: rating + review count from reviews apps (Okendo, Yotpo...).
export async function getProductRating(origin: string, handle: string) {
  const res = await fetchText(`${origin}/products/${handle}`);
  if (!res.ok) return null;
  for (const m of res.text.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    const block = m[1];
    if (!block.includes("aggregateRating")) continue;
    const value = block.match(/"ratingValue"\s*:\s*"?([\d.]+)/)?.[1];
    const count = block.match(/"(?:ratingCount|reviewCount)"\s*:\s*"?(\d+)/)?.[1];
    if (value && count) return { rating: Number(value), count: Number(count), url: res.url };
  }
  return null;
}

export { looksBlocked };
