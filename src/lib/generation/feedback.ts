import "server-only";
import { experimental_decide, generateText, Output } from "ai";
import { z } from "zod";
import { env } from "../env";

// Route marketer feedback to the cheapest change that satisfies it:
//   copy  -> re-render text layer only (reuse scene, ~1s, no fal call)
//   scene -> new background, same copy
//   brief -> update the campaign brief (voice / avoid list) and rewrite copy
//
// Two steps: a decision model (Jev, via AI Gateway) decides the route and returns
// probabilities; a language model then writes the details for that route. If the
// router isn't confident, we ask the marketer instead of guessing.

export type FeedbackKind = "copy" | "scene" | "brief";
export const ROUTE_CONFIDENCE = 0.6; // below this, ask a clarifying question

const KIND_CRITERIA: Record<FeedbackKind, string> = {
  copy: "The words of this one ad: headline, subline, button text, length, wording or tone of the copy.",
  scene: "The picture of this one ad: setting, background, colors, lighting, mood, props or composition.",
  brief: "A brand-wide rule for all future ads, e.g. words or claims to never use, or the overall brand voice.",
};

type Route = {
  kind: FeedbackKind;
  alsoChangeCopy: boolean;
  confidence: number | null;
  probabilities: Record<string, number> | null;
  router: string; // model that made the decision, e.g. "typesafe-ai/jev" or the LLM fallback
};

async function routeWithDecisionModel(state: Record<string, string>): Promise<Route> {
  const result = await experimental_decide({
    model: env.routerModel(),
    state,
    questions: {
      kind: { type: "choice", instructions: "What needs to change to satisfy the marketer's feedback?", criteria: KIND_CRITERIA },
      alsoChangeCopy: { type: "boolean", instructions: "Does the feedback also ask for different wording (headline, subline or button)?" },
    },
  });
  const k = result.answers.kind;
  const probabilities = (k.probabilities as Record<string, number> | undefined) ?? null;
  return {
    kind: k.choice as FeedbackKind,
    alsoChangeCopy: result.answers.alsoChangeCopy.probability >= 0.5,
    confidence: probabilities?.[k.choice] ?? null,
    probabilities,
    router: env.routerModel(),
  };
}

const details = z.object({
  copyInstruction: z.string().nullable().describe("What to change in the words, if anything"),
  sceneInstruction: z.string().nullable().describe("What to change in the visual, if anything"),
  newSceneDirection: z
    .string()
    .nullable()
    .describe(
      "For scene changes: the COMPLETE replacement scene description (max 35 words: place, surface, props, light, mood). Keep whatever the feedback doesn't change. No text, no people unless the product photo already has them. Null otherwise.",
    ),
  briefChange: z
    .object({
      addAvoid: z.array(z.string()).describe("words/claims to never use again"),
      voiceAdjectives: z.array(z.string()).nullable().describe("replacement voice adjectives, if the tone should change"),
    })
    .nullable(),
  summary: z.string().describe("Short label of the change for the version history, e.g. 'Brighter, outdoor scene' or 'Shorter headline'"),
});

// Fallback router: the LLM classifies when the decision model is unavailable.
const llmRoute = z.object({ kind: z.enum(["copy", "scene", "brief"]), alsoChangeCopy: z.boolean() });

export type FeedbackPlan = z.infer<typeof details> & Route & { needsClarification: boolean };

export async function planFeedback(opts: { feedback: string; current: { headline: string; subline?: string | null; cta: string; sceneDirection?: string } }): Promise<FeedbackPlan> {
  const adText = `headline: "${opts.current.headline}", subline: "${opts.current.subline ?? ""}", CTA: "${opts.current.cta}", scene: "${opts.current.sceneDirection ?? ""}"`;

  let route: Route;
  try {
    route = await routeWithDecisionModel({ currentAd: adText, feedback: opts.feedback });
  } catch (e) {
    console.warn("decision-model routing failed, falling back to LLM:", (e as Error).message);
    const { output } = await generateText({
      model: env.fastModel(),
      output: Output.object({ schema: llmRoute }),
      instructions: `Classify ad feedback. ${Object.entries(KIND_CRITERIA).map(([k, v]) => `'${k}' = ${v}`).join(" ")}`,
      prompt: `Current ad: ${adText}\nFeedback: ${opts.feedback}`,
    });
    route = { ...output, confidence: null, probabilities: null, router: `${env.fastModel()} (fallback)` };
  }

  const needsClarification = route.confidence !== null && route.confidence < ROUTE_CONFIDENCE;
  if (needsClarification) {
    return { ...route, needsClarification, copyInstruction: null, sceneInstruction: null, newSceneDirection: null, briefChange: null, summary: "Needs clarification" };
  }

  const { output } = await generateText({
    model: env.fastModel(),
    output: Output.object({ schema: details }),
    instructions: `Turn ad feedback into concrete instructions. The change has already been classified as '${route.kind}' (${KIND_CRITERIA[route.kind]}). Fill in only what that kind of change needs; leave the rest null.`,
    prompt: `Current ad: ${adText}\nFeedback: ${opts.feedback}`,
  });
  return { ...output, ...route, needsClarification };
}
