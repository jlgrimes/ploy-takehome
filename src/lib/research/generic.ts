import "server-only";
import { fetchJson, fetchText } from "./fetch";
import type { ShopifyProduct } from "./shopify";

// Fallback for a single pasted product URL when there is no open Shopify catalog:
// 1) Shopify's per-product JSON (`/products/x.json`), 2) schema.org Product JSON-LD,
// which most ecommerce platforms emit. Returned in the Shopify shape so the rest of
// the pipeline doesn't care where it came from.
export async function productFromPage(url: string): Promise<ShopifyProduct | null> {
  const clean = url.split("?")[0].replace(/\/$/, "");
  if (/\/products\//.test(clean)) {
    const { data } = await fetchJson<{ product: ShopifyProduct }>(`${clean}.json`);
    if (data?.product) return data.product;
  }
  const page = await fetchText(url);
  if (!page.ok) return null;
  for (const m of page.text.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let json: unknown;
    try {
      json = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    const nodes = (Array.isArray(json) ? json : [json]).flatMap((n: Record<string, unknown>) => (Array.isArray(n?.["@graph"]) ? (n["@graph"] as unknown[]) : [n])) as Record<string, unknown>[];
    const prod = nodes.find((n) => String(n?.["@type"]).toLowerCase().includes("product"));
    if (!prod) continue;
    const images = ([] as unknown[]).concat(prod.image ?? []).map((i) => (typeof i === "string" ? i : (i as { url?: string })?.url)).filter(Boolean) as string[];
    const offer = ([] as Record<string, unknown>[]).concat((prod.offers as Record<string, unknown>) ?? [])[0];
    const handle = clean.split("/").pop() || "product";
    return {
      id: 0,
      title: String(prod.name ?? handle),
      handle,
      body_html: String(prod.description ?? ""),
      vendor: String((prod.brand as { name?: string })?.name ?? ""),
      product_type: String(prod.category ?? ""),
      tags: [],
      variants: [{ id: 0, price: String(offer?.price ?? ""), compare_at_price: null, available: !/OutOfStock/i.test(String(offer?.availability ?? "")) }],
      // Unknown dimensions: assume usable; the generator re-checks real pixel size.
      images: images.slice(0, 8).map((src, i) => ({ id: i, src, width: 1000, height: 1000, alt: String(prod.name ?? ""), position: i + 1 })),
    };
  }
  return null;
}
