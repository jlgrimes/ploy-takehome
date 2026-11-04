import "server-only";
import { generateText, Output } from "ai";
import sharp from "sharp";
import { z } from "zod";
import { env } from "../env";

// Vision QA on the generated scene (before our text layer is drawn). Compares the
// result with the original product photo, so text that was already in the brand's
// photo is allowed and only NEW text counts as a failure.

const schema = z.object({
  inventedText: z.boolean().describe("true if the generated image contains letters, words, numbers, logos or signage that do NOT appear in the original product photo"),
  productMatches: z.boolean().describe("true if the product in the generated image is clearly the same product as in the original photo (shape, color, print)"),
  zonesClear: z.boolean().describe("true if the areas described as quiet are free of busy objects"),
  notes: z.string().describe("one short sentence"),
});
export type QaResult = z.infer<typeof schema> & { checked: boolean; productPixelsPasted: boolean };

const small = (b: Buffer) => sharp(b).resize({ width: 512, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();

export async function checkScene(opts: { original: Buffer; scene: Buffer; zonesHint: string; productPixelsPasted: boolean }): Promise<QaResult> {
  try {
    const [orig, scene] = await Promise.all([small(opts.original), small(opts.scene)]);
    const { output } = await generateText({
      model: env.fastModel(),
      output: Output.object({ schema }),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Image 1 is the ORIGINAL product photo from the store. Image 2 is a GENERATED ad background built around it." },
            { type: "file", mediaType: "image/jpeg", data: orig },
            { type: "file", mediaType: "image/jpeg", data: scene },
            { type: "text", text: `Check image 2. Quiet areas that must stay uncluttered: ${opts.zonesHint}` },
          ],
        },
      ],
    });
    return { ...output, productMatches: opts.productPixelsPasted || output.productMatches, checked: true, productPixelsPasted: opts.productPixelsPasted };
  } catch (e) {
    // QA unavailable shouldn't block the ad; record that it wasn't checked.
    return { inventedText: false, productMatches: opts.productPixelsPasted, zonesClear: true, notes: `QA skipped: ${(e as Error).message.slice(0, 120)}`, checked: false, productPixelsPasted: opts.productPixelsPasted };
  }
}
