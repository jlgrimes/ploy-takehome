import { convertToModelMessages, createUIMessageStreamResponse, isStepCount, streamText, toUIMessageStream, type UIMessage } from "ai";
import { campaignTools } from "@/lib/agent/tools";
import { agentInstructions } from "@/lib/agent/instructions";
import { getCampaignState } from "@/lib/campaign-state";
import { db } from "@/lib/db";
import { env } from "@/lib/env";

// Research + 3 parallel generations (with one QA retry each) can take a couple of minutes.
export const maxDuration = 300;

export async function POST(req: Request) {
  const { messages, campaignId }: { messages: UIMessage[]; campaignId: string } = await req.json();
  const state = await getCampaignState(campaignId);
  if (!state) return new Response("Campaign not found", { status: 404 });

  const result = streamText({
    model: env.agentModel(),
    instructions: agentInstructions(state),
    messages: await convertToModelMessages(messages),
    tools: campaignTools(campaignId),
    stopWhen: isStepCount(10),
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: result.stream,
      originalMessages: messages,
      onEnd: async ({ messages: all }) => {
        // Persist the whole thread (idempotent upsert keyed by message id).
        const rows = all.map((m, i) => ({ id: m.id, campaign_id: campaignId, role: m.role, parts: m.parts, created_at: new Date(Date.now() - (all.length - i)).toISOString() }));
        const { error } = await db().from("messages").upsert(rows, { onConflict: "id" });
        if (error) console.error("save messages", error.message);
      },
      onError: (e) => (e instanceof Error ? e.message : "Something went wrong"),
    }),
  });
}
