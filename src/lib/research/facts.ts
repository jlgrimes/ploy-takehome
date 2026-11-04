// Deterministic fact extraction. A "fact" is the only kind of claim an ad may make
// (numbers, guarantees, ratings). Each keeps the exact source it was read from.

export type FactDraft = {
  kind: string;
  text: string;
  value?: unknown;
  source_kind: string;
  source_url: string | null;
  product_handle?: string | null;
};

const PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: "review_count", re: /\b(\d[\d,.]*\s*[kK]?\+?\s*(?:five|5)[- ]star reviews)\b/i },
  { kind: "review_count", re: /\b(\d[\d,.]*\s*[kK]?\+?\s*(?:verified\s+)?reviews)\b/i },
  { kind: "customers", re: /\b(\d[\d,.]*\s*[kKmM]?\+?\s*(?:happy|satisfied|loyal)?\s*customers)\b/i },
  { kind: "warranty", re: /\b(lifetime warranty|\d+[- ](?:year|month)s? warranty)\b/i },
  { kind: "returns", re: /\b(risk[- ]free returns|free returns|\d+[- ]day (?:money[- ]back guarantee|returns?|guarantee|trial))\b/i },
  { kind: "shipping", re: /\b(free (?:shipping|delivery)(?: on orders? over \$?\d+| over \$?\d+)?)\b/i },
  { kind: "founded", re: /\b((?:trusted |serving customers )?since (?:19|20)\d{2})\b/i },
];

export function factsFromText(text: string | null, source_kind: string, source_url: string | null): FactDraft[] {
  if (!text) return [];
  const out: FactDraft[] = [];
  for (const { kind, re } of PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const phrase = m[1].replace(/\s+/g, " ").trim();
    if (out.some((f) => f.text.toLowerCase() === phrase.toLowerCase())) continue;
    out.push({ kind, text: phrase.charAt(0).toUpperCase() + phrase.slice(1), source_kind, source_url });
  }
  return out;
}

export function ratingFact(r: { rating: number; count: number; url: string }, handle: string): FactDraft {
  return {
    kind: "rating",
    text: `${r.rating.toFixed(1)} stars from ${r.count.toLocaleString("en-US")} reviews`,
    value: r,
    source_kind: "json_ld",
    source_url: r.url,
    product_handle: handle,
  };
}

// Used by the copy validator: every number in ad copy must appear in a cited fact.
export function numbersIn(s: string): string[] {
  return (s.match(/\d[\d,.]*/g) ?? []).map((n) => n.replace(/[,.]$/, "").replace(/,/g, ""));
}
