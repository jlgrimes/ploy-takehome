import "server-only";
import { generateText, Output } from "ai";
import { z } from "zod";
import { env } from "../env";
import type { AngleKey } from "../types";

// The LLM only does judgment here: voice, value prop, which shortlisted products to
// lead with, and which angle fits each. It can only reference products by handle
// from the shortlist we give it, and any extra "fact" it proposes must quote the
// source text verbatim or it is dropped.

export type SynthesisInput = {
  brandName: string;
  description: string | null;
  aboutText: string | null;
  shortlist: { handle: string; title: string; type: string; price: string | null; why: string[]; blurb: string }[];
  facts: { kind: string; text: string }[];
};

const schema = z.object({
  voice: z.object({
    adjectives: z.array(z.string()).min(2).max(4).describe("2-4 adjectives describing the brand's tone"),
    example: z.string().describe("One short line written in the brand's voice, max 12 words, no invented numbers or claims"),
  }),
  valueProp: z.string().describe("The single reason people buy, max 14 words, plain language"),
  sellingPoints: z.array(z.string()).min(2).max(6).describe("Short selling points drawn from the store copy"),
  picks: z
    .array(
      z.object({
        handle: z.string(),
        angle: z.enum(["benefit", "social_proof", "lifestyle", "feature", "gift"]),
        why: z.string().describe("One short sentence a marketer would accept, e.g. 'Your #3 best seller and the clearest product photo'"),
      }),
    )
    .length(3),
  extraFacts: z
    .array(z.object({ kind: z.string(), text: z.string(), quote: z.string().describe("exact substring of the source text") }))
    .max(4),
});

export async function synthesize(input: SynthesisInput) {
  const sourceText = [input.description, input.aboutText, ...input.shortlist.map((s) => s.blurb)].filter(Boolean).join("\n");
  const { output } = await generateText({
    model: env.agentModel(),
    output: Output.object({ schema }),
    instructions:
      "You are a senior performance-marketing strategist preparing the first ads for a brand on AppLovin: full-screen portrait ads shown between levels of mobile games, to cold audiences who have ~2 seconds. Be concrete and grounded strictly in the provided store data. Never invent numbers, discounts, awards or claims.",
    prompt: `Brand: ${input.brandName}
Store description: ${input.description ?? "(none)"}
About text: ${input.aboutText?.slice(0, 1500) ?? "(none)"}

Verified facts (the only claims ads may make):
${input.facts.map((f) => `- [${f.kind}] ${f.text}`).join("\n") || "(none)"}

Shortlisted products (pre-ranked by sales, stock, photo quality; pick exactly 3 handles from this list):
${input.shortlist.map((s, i) => `${i + 1}. handle=${s.handle} | ${s.title} | type=${s.type || "-"} | price=${s.price ?? "-"} | signals: ${s.why.join(", ") || "-"} | ${s.blurb.slice(0, 220)}`).join("\n")}

Rules for picks:
- Prefer the top-ranked core products; skip anything that's an accessory to the main product unless the catalog is tiny.
- Pick 3 visually distinct products when possible; reuse a product only if fewer than 3 are suitable.
- Give each pick a different angle. Use "social_proof" only if a rating/review fact exists.
- extraFacts: only claims that appear verbatim in the description/about/product text (e.g. "machine washable", "made in USA"), quoting the exact source substring.`,
  });

  const handles = new Set(input.shortlist.map((s) => s.handle));
  const hasProof = input.facts.some((f) => f.kind === "rating" || f.kind === "review_count");
  const picks = output.picks
    .filter((p) => handles.has(p.handle))
    .map((p) => ({ ...p, angle: (p.angle === "social_proof" && !hasProof ? "benefit" : p.angle) as AngleKey }));
  const lower = sourceText.toLowerCase();
  const extraFacts = output.extraFacts.filter((f) => f.quote.length >= 4 && lower.includes(f.quote.toLowerCase()));
  return { ...output, picks, extraFacts };
}
