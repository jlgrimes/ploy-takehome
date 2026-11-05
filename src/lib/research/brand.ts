import "server-only";

// Heuristic brand extraction from homepage HTML. Verified on real stores that this
// is uneven (logos are <img> on some themes, inline <svg> on others; color tokens
// use theme-specific names), so every field reports where it came from and the
// brief card shows what's missing instead of guessing silently.

const attr = (tag: string, name: string) =>
  tag.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1]?.replace(/&amp;/g, "&") ?? null;

export const metaContent = (html: string, key: string) => {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, "i");
  const tag = html.match(re)?.[0];
  return tag ? attr(tag, "content")?.trim() || null : null;
};

export function absolutize(src: string, origin: string): string {
  if (src.startsWith("//")) return "https:" + src;
  if (src.startsWith("/")) return origin + src;
  if (!/^https?:/i.test(src)) return `${origin}/${src}`;
  return src.replace(/^http:/, "https:");
}

export type LogoCandidate =
  | { type: "img"; url: string; score: number; why: string }
  | { type: "svg"; svg: string; score: number; why: string };

// Score images that look like the site logo. Badges ("30 day guarantee", payment
// icons) also contain the word "logo" in alt text, so they're penalized.
export function findLogo(html: string, origin: string, brandName: string | null): LogoCandidate | null {
  const headerEnd = Math.min(html.length, Math.max(html.search(/<\/header>/i), 0) || 200_000);
  const candidates: LogoCandidate[] = [];
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = attr(tag, "src") ?? attr(tag, "data-src");
    if (!src || src.startsWith("data:")) continue;
    const cls = attr(tag, "class") ?? "";
    const alt = attr(tag, "alt") ?? "";
    const file = src.split("?")[0].split("/").pop() ?? "";
    let score = 0;
    const why: string[] = [];
    const add = (n: number, reason: string) => {
      score += n;
      why.push(reason);
    };
    if (/logo/i.test(cls)) add(4, "class");
    if (/logo/i.test(file)) add(3, "filename");
    if (brandName && alt && alt.toLowerCase().includes(brandName.toLowerCase().slice(0, 5))) add(2, "alt");
    if ((m.index ?? 0) < headerEnd) add(2, "header");
    if (/guarantee|ship|payment|visa|paypal|badge|award|press|review|icon|flag|trust|secure/i.test(file + " " + alt)) score -= 6;
    if (score >= 4) candidates.push({ type: "img", url: absolutize(src, origin), score, why: why.join("+") });
  }
  // Inline SVG logos (e.g. themes that embed the wordmark). Verified failure on
  // liquiddeath.com: an account icon's markup also mentions "logo". Wordmarks are
  // wide, so require a wide viewBox (or the brand name in the label) and skip UI icons.
  for (const m of html.slice(0, headerEnd + 50_000).matchAll(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi)) {
    const svg = m[0];
    const open = svg.slice(0, 600);
    if (!/logo/i.test(open)) continue;
    if (svg.length < 300 || svg.length > 200_000) continue;
    if (/account|user|profile|cart|bag|search|menu|close|arrow|chevron|instagram|facebook|tiktok|twitter|youtube|pinterest|social/i.test(open)) continue;
    const vb = open.match(/viewBox=["']\s*[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
    const aspect = vb ? Number(vb[1]) / Math.max(1, Number(vb[2])) : 1;
    const named = !!brandName && new RegExp(brandName.split(/\s+/)[0], "i").test(open);
    if (aspect < 1.4 && !named) continue;
    candidates.push({ type: "svg", svg, score: 5 + (aspect >= 2 ? 2 : 0) + (named ? 2 : 0), why: `inline svg (${aspect.toFixed(1)}:1)` });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] ?? null;
}

const HEX = /#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/i;
const normHex = (h: string) =>
  h.length === 4 ? "#" + [...h.slice(1)].map((c) => c + c).join("").toUpperCase() : h.toUpperCase();

// Collect color tokens from inline theme CSS. Covers custom (--color-primary: #hex)
// and Dawn-style (--color-base-accent-1: 18, 18, 18) declarations.
export function findColors(html: string): { primary: string | null; background: string | null; ink: string | null; source: string } {
  const vars = new Map<string, string>();
  for (const m of html.matchAll(/--([a-z0-9-]*colou?r[a-z0-9-]*)\s*:\s*([^;}{]+)[;}]/gi)) {
    const name = m[1].toLowerCase();
    const val = m[2].trim();
    let hex: string | null = null;
    const h = val.match(HEX);
    if (h) hex = normHex(h[0]);
    else {
      const rgb = val.match(/^(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})$/);
      if (rgb) hex = "#" + rgb.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, "0")).join("").toUpperCase();
    }
    if (hex && !vars.has(name)) vars.set(name, hex);
  }
  const pick = (patterns: RegExp[]) => {
    for (const p of patterns) for (const [k, v] of vars) if (p.test(k)) return v;
    return null;
  };
  const isGray = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return Math.max(r, g, b) - Math.min(r, g, b) < 18;
  };
  let primary = pick([/primary(?!-content)/, /brand/, /accent-1|accent(?!-content)/, /button(?!-text|-label)/]);
  if (primary && isGray(primary)) primary = pick([/accent-2/, /secondary/]) ?? primary;
  const background = pick([/base-100|background-1|^color-background$|bg/]);
  const ink = pick([/base-content|foreground|^color-text$|text(?!-on)|body/]);
  return { primary, background, ink, source: vars.size ? "theme css variables" : "none" };
}

// Font: heading family + a downloadable woff/ttf (satori can't read woff2).
export function findHeadingFont(html: string, origin: string): { family: string; url: string | null } | null {
  const varFamily = html.match(/--font-heading-family\s*:\s*["']?([^,;"']+)/i)?.[1]?.trim();
  const faces = [...html.matchAll(/@font-face\s*{([^}]*)}/gi)].map((m) => {
    const body = m[1];
    const family = body.match(/font-family\s*:\s*["']?([^;"']+)/i)?.[1]?.trim() ?? "";
    const weight = Number(body.match(/font-weight\s*:\s*(\d+)/i)?.[1] ?? 400);
    const woff = body.match(/url\(["']?([^)"']+\.(?:woff|ttf|otf)(?:\?[^)"']*)?)["']?\)/i)?.[1] ?? null;
    return { family, weight, woff };
  });
  // Skip icon/widget fonts (verified on graza.co: a reviews widget's "oke-widget-icons").
  const isIconFont = (f: string) => /icon|widget|awesome|glyph|slick|swiper|material symbols|dashicons/i.test(f);
  const family = [varFamily, ...faces.map((f) => f.family)].find((f) => f && !isIconFont(f));
  if (!family) return null;
  const sameFamily = faces.filter((f) => f.family.toLowerCase() === family.toLowerCase() && f.woff);
  const best = sameFamily.sort((a, b) => Math.abs(700 - a.weight) - Math.abs(700 - b.weight))[0];
  return { family, url: best?.woff ? absolutize(best.woff, origin) : null };
}

export function pageBasics(html: string) {
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? null;
  return {
    siteName: metaContent(html, "og:site_name"),
    title,
    description: metaContent(html, "description") ?? metaContent(html, "og:description"),
    ogImage: metaContent(html, "og:image"),
    themeColor: metaContent(html, "theme-color"),
  };
}

// Strip registered marks and tagline suffixes: "Loopy®Cases" -> "Loopy Cases".
export function cleanBrandName(raw: string | null): string | null {
  if (!raw) return null;
  return raw
    .replace(/[®™©]/g, " ")
    .split(/\s[|–—-]\s/)[0]
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}
