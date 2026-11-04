import "server-only";
import { tool } from "ai";
import { z } from "zod";
import { runResearch } from "../research";
import { generateCampaignAds, reviseAd } from "../generation/pipeline";

// Agent tools, bound to one campaign. Long-running tools are async generators: each
// yield streams to the UI as a preliminary result (live progress); the last yield
// is what the model sees.

export function campaignTools(campaignId: string) {
  return {
    researchStore: tool({
      description:
        "Research an ecommerce store from its URL: catalog, best sellers, brand identity (logo, colors, font), verified facts (ratings, guarantees), and pick 3 products + angles for the first ads. Call this first whenever the user gives a store or product URL.",
      inputSchema: z.object({ url: z.string().describe("Store or product URL exactly as the user gave it") }),
      async *execute({ url }) {
        for await (const ev of runResearch({ campaignId, url })) yield ev;
      },
    }),

    // Client-side tool (no execute): the UI renders the editable brief card and the
    // agent waits here until the marketer confirms. This is the human checkpoint
    // before any image is generated.
    confirmBrief: tool({
      description:
        "Show the marketer the proposed creative brief (products, angles, brand voice, offer, words to avoid) and wait for them to confirm or edit it. Always call this after research and before generating ads.",
      inputSchema: z.object({ note: z.string().describe("One short sentence introducing the brief, e.g. what you'd lead with and why") }),
      outputSchema: z.object({
        confirmed: z.boolean(),
        changes: z.array(z.string()).describe("What the marketer changed on the brief, if anything"),
      }),
    }),

    generateAds: tool({
      description: "Generate the first set of ads from the confirmed brief (one per concept). Only call after confirmBrief returned confirmed=true.",
      inputSchema: z.object({}),
      async *execute() {
        let last: Awaited<ReturnType<typeof generateCampaignAds>> extends AsyncGenerator<infer T> ? T : never = [];
        for await (const snapshot of generateCampaignAds(campaignId)) {
          last = snapshot;
          yield { ads: snapshot, done: false };
        }
        yield { ads: last, done: true };
      },
    }),

    reviseAd: tool({
      description:
        "Apply the marketer's feedback to one ad. The system decides whether it's a copy change (instant, keeps the image), a new scene, or a brand-wide brief change. Use the ad id from the current ads list.",
      inputSchema: z.object({
        adId: z.string(),
        feedback: z.string().describe("The marketer's feedback, in their words (lightly clarified if needed)"),
      }),
      async *execute({ adId, feedback }) {
        for await (const ev of reviseAd({ adId, feedback })) yield ev;
      },
    }),
  };
}

export type CampaignTools = ReturnType<typeof campaignTools>;
