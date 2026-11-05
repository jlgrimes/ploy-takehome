import "server-only";
import { generateText, Output } from "ai";
import { z } from "zod";
import { env } from "../env";

// Route marketer feedback to the cheapest change that satisfies it:
//   copy  -> re-render text layer only (reuse scene, ~1s, no fal call)
//   scene -> new background, same copy
//   brief -> update the campaign brief (voice / avoid list) and rewrite copy
const schema = z.object({
  kind: z.enum(["copy", "scene", "brief"]),
  copyInstruction: z.string().nullable().describe("What to change in the words, if anything"),
  sceneInstruction: z.string().nullable().describe("What to change in the visual, if anything"),
  newSceneDirection: z
    .string()
    .nullable()
    .describe(
      "For scene feedback: the COMPLETE replacement scene description (max 35 words: place, surface, props, light, mood). Keep whatever the feedback doesn't change. No text, no people unless the product photo already has them. Null otherwise.",
    ),
  alsoChangeCopy: z.boolean().describe("for scene feedback: does the copy also need to change?"),
  briefChange: z
    .object({
      addAvoid: z.array(z.string()).describe("words/claims to never use again"),
      voiceAdjectives: z.array(z.string()).nullable().describe("replacement voice adjectives, if the tone should change"),
    })
    .nullable(),
  summary: z.string().describe("Short label of the change for the version history, e.g. 'Brighter, outdoor scene' or 'Shorter headline'"),
});
export type FeedbackPlan = z.infer<typeof schema>;

export async function planFeedback(opts: { feedback: string; current: { headline: string; subline?: string | null; cta: string; sceneDirection?: string } }) {
  const { output } = await generateText({
    model: env.fastModel(),
    output: Output.object({ schema }),
    instructions:
      "Classify ad feedback. 'copy' = about words/wording/CTA/length/tone of one ad. 'scene' = about the picture: setting, colors, lighting, mood, props, composition. 'brief' = a brand-wide rule that should apply to all future ads (e.g. 'we never say cheap', 'we're more playful than this').",
    prompt: `Current ad — headline: "${opts.current.headline}", subline: "${opts.current.subline ?? ""}", CTA: "${opts.current.cta}", scene: "${opts.current.sceneDirection ?? ""}"\nFeedback: ${opts.feedback}`,
  });
  return output;
}
