import "server-only";
import { generateText, Output } from "ai";
import { z } from "zod";
import { env } from "../env";
import { numbersIn } from "../research/facts";
import { ANGLES, type AdCopy, type AngleKey, type Brief } from "../types";

// Ad copy + scene direction for one ad. Grounding is enforced in code, not just in
// the prompt: every number must come from a cited fact, offers only if the marketer
// typed one, and banned words are rejected. Failures are fed back for a retry.

export type Fact = { id: string; kind: string; text: string; product_id: string | null };

const schema = z.object({
  headline: z.string().describe("2-6 words, max 32 characters. Punchy, in the brand voice. Readable in 1 second."),
  subline: z.string().nullable().describe("Optional supporting line, max 60 characters, or null"),
  cta: z.string().describe("Button label, 1-3 words"),
  factIds: z.array(z.string()).describe("ids of the facts this copy relies on (required for any number, rating, guarantee or claim)"),
  showRating: z
    .boolean()
    .describe("true only for social-proof ads that cite a rating or review fact. The renderer then prints that fact as a star row above the headline, so the headline should carry the benefit, not repeat the number."),
  sceneDirection: z
    .string()
    .describe("Visual setting for the background, max 35 words: place, surface, props, light, mood. Matches the brand. No people unless the product photo already has them. No text."),
});

export type CopyDraft = AdCopy & { sceneDirection: string };

export function validateCopy(c: CopyDraft, facts: Fact[], brief: Brief): string[] {
  const errs: string[] = [];
  if (c.headline.length > 38) errs.push(`Headline is ${c.headline.length} chars; max 32.`);
  if ((c.subline?.length ?? 0) > 80) errs.push("Subline too long; max 60 chars.");
  if (c.cta.split(/\s+/).length > 3) errs.push("CTA must be 1-3 words.");
  const cited = facts.filter((f) => c.factIds.includes(f.id));
  const unknown = c.factIds.filter((id) => !facts.some((f) => f.id === id));
  if (unknown.length) errs.push(`Unknown fact ids: ${unknown.join(", ")}.`);
  const allowedNums = new Set([...cited.flatMap((f) => numbersIn(f.text)), ...(brief.offer ? numbersIn(brief.offer) : [])]);
  for (const field of [c.headline, c.subline ?? ""]) {
    for (const n of numbersIn(field)) if (!allowedNums.has(n)) errs.push(`"${n}" in "${field}" isn't backed by a cited fact.`);
  }
  const text = `${c.headline} ${c.subline ?? ""}`.toLowerCase();
  if (!brief.offer && /(%|\bsale\b|\bdiscount|\bpercent\b|\b\d+\s*off\b|\bdeal\b|\bcoupon|\bpromo)/i.test(text)) errs.push("Mentions a discount/offer, but the marketer confirmed no offer.");
  for (const word of brief.avoid) if (word.trim() && text.includes(word.trim().toLowerCase())) errs.push(`Uses "${word}", which the brand asked to avoid.`);
  const proof = cited.find((f) => f.kind === "rating" || f.kind === "review_count");
  if (c.showRating && !proof) errs.push("showRating requires citing a rating or review fact.");
  // The star row already prints the proof line; repeating its number in the headline wastes the headline.
  if (c.showRating && proof && numbersIn(c.headline).some((n) => numbersIn(proof.text).includes(n)))
    errs.push(`The rating row already says "${proof.text}"; the headline must say something else (the benefit), not repeat it.`);
  return errs;
}

export async function writeCopy(opts: {
  brandName: string;
  brief: Brief;
  angle: AngleKey;
  product: { title: string; description: string | null; product_type: string | null; price: number | null };
  facts: Fact[];
  previous?: { headline: string; subline?: string | null; cta: string; sceneDirection?: string } | null;
  instruction?: string | null; // from marketer feedback
  keepScene?: boolean;
}): Promise<CopyDraft> {
  const angle = ANGLES[opts.angle];
  let lastErrors: string[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const { output } = await generateText({
      model: env.agentModel(),
      output: Output.object({ schema }),
      instructions: `You write full-screen portrait (9:16) interstitial image ads that appear between levels of mobile games, for ${opts.brandName}. Viewers are cold and have ~2 seconds: one idea, few words, concrete benefit. Write in the brand's voice. Never invent facts, numbers, discounts, awards or comparisons; only use the provided facts. Copy is drawn by our own renderer over the image, so never describe text in sceneDirection.`,
      prompt: `Brand voice: ${opts.brief.voice.adjectives.join(", ")} — e.g. "${opts.brief.voice.example}"
Value proposition: ${opts.brief.valueProp}
Angle for this ad: ${angle.label} (${angle.hint})
Default CTA: ${opts.brief.cta}
Offer: ${opts.brief.offer ? `"${opts.brief.offer}" (may be used verbatim)` : "NONE — do not mention discounts, sales or deals"}
Words/claims to avoid: ${opts.brief.avoid.length ? opts.brief.avoid.join(", ") : "none"}

Product: ${opts.product.title}${opts.product.product_type ? ` (${opts.product.product_type})` : ""}${opts.product.price ? `, $${opts.product.price}` : ""}
Product copy: ${(opts.product.description ?? "").slice(0, 600)}

Facts you may cite (id: text):
${opts.facts.map((f) => `${f.id}: ${f.text}`).join("\n") || "(none)"}
${opts.previous ? `\nCurrent version — headline: "${opts.previous.headline}", subline: "${opts.previous.subline ?? ""}", CTA: "${opts.previous.cta}", scene: "${opts.previous.sceneDirection ?? ""}"` : ""}
${opts.instruction ? `\nMarketer feedback to apply: ${opts.instruction}${opts.keepScene ? " (only the copy changes; keep sceneDirection the same)" : ""}` : ""}
${lastErrors.length ? `\nYour previous attempt was rejected:\n- ${lastErrors.join("\n- ")}\nFix these.` : ""}`,
    });
    const draft: CopyDraft = {
      headline: output.headline.trim(),
      subline: output.subline?.trim() || null,
      cta: output.cta.trim(),
      factIds: output.factIds,
      showRating: output.showRating,
      sceneDirection: opts.keepScene && opts.previous?.sceneDirection ? opts.previous.sceneDirection : output.sceneDirection.trim(),
    };
    lastErrors = validateCopy(draft, opts.facts, opts.brief);
    if (!lastErrors.length) return draft;
    console.warn("copy rejected", lastErrors);
  }
  throw new Error(`Couldn't write grounded copy: ${lastErrors.join(" ")}`);
}
