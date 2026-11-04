import { convertToModelMessages, createIdGenerator, createUIMessageStreamResponse, isStepCount, streamText, toUIMessageStream, type UIMessage } from "ai";
import { waitUntil } from "@vercel/functions";
import { campaignTools } from "@/lib/agent/tools";
import { agentInstructions } from "@/lib/agent/instructions";
import { getCampaignState } from "@/lib/campaign-state";
import { db } from "@/lib/db";
import { env } from "@/lib/env";

// Research + 3 parallel generations (with one QA retry each) can take a couple of minutes.
export const maxDuration = 300;

const newMessageId = createIdGenerator({ prefix: "msg", size: 16 });

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
      // Server-generated ids for assistant messages: without this the id is empty and
      // every campaign's assistant message collides on the same primary key.
      generateMessageId: newMessageId,
      onEnd: ({ messages: all }) => {
        // Persist the whole thread (idempotent upsert keyed by message id). waitUntil
        // keeps the function alive for the write after the response stream closes.
        const rows = all
          .filter((m) => m.id)
          .map((m, i) => ({ id: m.id, campaign_id: campaignId, role: m.role, parts: m.parts, created_at: new Date(Date.now() - (all.length - i)).toISOString() }));
        waitUntil(
          Promise.resolve(db().from("messages").upsert(rows, { onConflict: "id" })).then(({ error }) => {
            if (error) console.error("save messages", error.message);
          }),
        );
      },
      onError: (e) => (e instanceof Error ? e.message : "Something went wrong"),
    }),
  });
}
