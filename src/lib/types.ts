// Shared (client-safe) shapes.

export type Provenance = "scraped" | "inferred" | "user" | "default" | "missing";

export type BriefConcept = {
  productId: string;
  angle: AngleKey;
  why: string; // shown on the brief card: why the agent picked this product
};

export type AngleKey = "benefit" | "social_proof" | "lifestyle" | "feature" | "offer" | "gift";

export const ANGLES: Record<AngleKey, { label: string; hint: string }> = {
  benefit: { label: "Core benefit", hint: "The one problem it solves" },
  social_proof: { label: "Social proof", hint: "Ratings and review counts" },
  lifestyle: { label: "Lifestyle", hint: "Who it's for and how it feels" },
  feature: { label: "Product detail", hint: "A specific design or material detail" },
  offer: { label: "Offer", hint: "Lead with the confirmed promotion" },
  gift: { label: "Giftable", hint: "Positioned as a gift" },
};

export type Brief = {
  concepts: BriefConcept[];
  offer: string | null; // never inferred; only what the marketer typed
  voice: { adjectives: string[]; example: string };
  valueProp: string;
  avoid: string[];
  cta: string;
};

export type ResearchStep = {
  key: string;
  label: string;
  status: "running" | "ok" | "degraded" | "failed" | "skipped";
  detail?: string;
  ms?: number;
};

export type AdCopy = {
  headline: string;
  subline?: string | null;
  cta: string;
  factIds: string[];
  showRating?: boolean;
};
