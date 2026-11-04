"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls, type InferUITools, type UIDataTypes, type UIMessage } from "ai";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { Loader2, Wand2 } from "lucide-react";
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { PromptInput, PromptInputBody, PromptInputFooter, PromptInputSubmit, PromptInputTextarea } from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import type { CampaignTools } from "@/lib/agent/tools";
import type { CampaignState } from "@/lib/campaign-state";
import type { Brief, ResearchStep } from "@/lib/types";
import type { AdProgress } from "@/lib/generation/pipeline";
import { BriefCard } from "./brief-card";
import { GenerationProgress } from "./generation-progress";
import { ResearchProgress } from "./research-progress";

export type StudioMessage = UIMessage<unknown, UIDataTypes, InferUITools<CampaignTools>>;

export function ChatPanel({
  campaignId,
  initialMessages,
  startUrl,
  state,
  refresh,
  registerSend,
}: {
  campaignId: string;
  initialMessages: StudioMessage[];
  startUrl: string | null;
  state: CampaignState;
  refresh: () => void;
  registerSend: (fn: (text: string) => void) => void;
}) {
  const { messages, sendMessage, addToolOutput, status, error } = useChat<StudioMessage>({
    id: campaignId,
    messages: initialMessages,
    transport: new DefaultChatTransport({ api: "/api/chat", body: { campaignId } }),
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    onFinish: () => refresh(),
    onError: (e) => toast.error(e.message || "The agent hit an error."),
  });

  // Kick off research for a brand-new campaign (once).
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !startUrl || initialMessages.length) return;
    started.current = true;
    window.history.replaceState(null, "", `/c/${campaignId}`);
    sendMessage({ text: `Create ads for ${startUrl}` });
  }, [startUrl, initialMessages.length, sendMessage, campaignId]);

  // The board can hand feedback to the agent.
  useEffect(() => registerSend((text) => sendMessage({ text })), [registerSend, sendMessage]);

  // Refresh board state whenever a tool part changes state (progress, completion).
  const toolSig = messages
    .flatMap((m) => m.parts)
    .filter((p) => p.type.startsWith("tool-"))
    .map((p) => `${(p as { toolCallId: string }).toolCallId}:${(p as { state: string }).state}:${JSON.stringify((p as { output?: unknown }).output ?? "").length}`)
    .join("|");
  useEffect(() => {
    if (toolSig) refresh();
  }, [toolSig, refresh]);

  const busy = status === "submitted" || status === "streaming";

  const confirmBrief = async (toolCallId: string, brief: Brief, changes: string[]) => {
    const res = await fetch(`/api/campaigns/${campaignId}/brief`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ brief }) });
    if (!res.ok) {
      toast.error((await res.json()).error ?? "Couldn't save the brief");
      return;
    }
    refresh();
    addToolOutput({ tool: "confirmBrief", toolCallId, output: { confirmed: true, changes } });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="gap-5 px-4 py-5">
          {messages.length === 0 ? (
            <ConversationEmptyState icon={<Wand2 className="size-6" />} title="Creative agent" description="Paste a store URL, or tell me what to change on an ad." />
          ) : null}
          {messages.map((m) => (
            <Message key={m.id} from={m.role} className="max-w-full">
              <MessageContent className={m.role === "assistant" ? "w-full max-w-full gap-3 bg-transparent p-0" : undefined}>
                {m.parts.map((part, i) => {
                  const key = `${m.id}-${i}`;
                  switch (part.type) {
                    case "text":
                      return m.role === "assistant" ? <MessageResponse key={key}>{part.text}</MessageResponse> : <p key={key} className="whitespace-pre-wrap">{part.text}</p>;
                    case "tool-researchStore": {
                      const out = part.state === "output-available" ? (part.output as { steps: ResearchStep[]; done: boolean }) : null;
                      if (part.state === "output-error") return <ToolError key={key} text={part.errorText} />;
                      return <ResearchProgress key={key} steps={out?.steps ?? []} done={!!out?.done} />;
                    }
                    case "tool-confirmBrief": {
                      if (!state.campaign.brief) return <Pending key={key} label="Preparing the brief" />;
                      const answered = part.state === "output-available";
                      return (
                        <BriefCard
                          key={`${key}-${state.campaign.briefConfirmedAt ?? "open"}`}
                          state={state}
                          note={part.state === "input-available" || answered ? part.input.note : undefined}
                          readOnly={answered || busy}
                          onConfirm={part.state === "input-available" ? (brief, changes) => confirmBrief(part.toolCallId, brief, changes) : undefined}
                        />
                      );
                    }
                    case "tool-generateAds": {
                      if (part.state === "output-error") return <ToolError key={key} text={part.errorText} />;
                      const out = part.state === "output-available" ? (part.output as { ads: AdProgress[]; done: boolean }) : null;
                      if (!out) return <Pending key={key} label="Starting generation" />;
                      return <GenerationProgress key={key} ads={out.ads} done={out.done} />;
                    }
                    case "tool-reviseAd": {
                      if (part.state === "output-error") return <ToolError key={key} text={part.errorText} />;
                      const out = part.state === "output-available" ? (part.output as { status: string; plan?: { summary?: string; kind?: string } }) : null;
                      const done = out?.status === "ready";
                      const kind = out?.plan?.kind;
                      return (
                        <div key={key} className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm">
                          {done ? <Wand2 className="size-4 text-brand" /> : out?.status === "failed" ? <Wand2 className="size-4 text-destructive" /> : <Loader2 className="size-4 animate-spin text-muted-foreground" />}
                          <span className="min-w-0 truncate">
                            {done ? `New version: ${out?.plan?.summary ?? "updated"}` : out?.status === "failed" ? "Revision failed" : out?.status ?? "Revising"}
                          </span>
                          {kind ? <span className="ml-auto shrink-0 rounded-full border px-2 py-px text-[10px] text-muted-foreground">{kind === "copy" ? "copy only" : kind === "scene" ? "new scene" : "brief"}</span> : null}
                        </div>
                      );
                    }
                    default:
                      return null;
                  }
                })}
              </MessageContent>
            </Message>
          ))}
          {status === "submitted" ? <Shimmer className="text-sm">Thinking…</Shimmer> : null}
          {error ? <p className="text-sm text-destructive">Something went wrong. You can retry by sending a message.</p> : null}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div className="border-t p-3">
        <PromptInput
          onSubmit={(msg) => {
            if (!msg.text.trim() || busy) return;
            sendMessage({ text: msg.text });
          }}
        >
          <PromptInputBody>
            <PromptInputTextarea placeholder={state.ads.length ? "e.g. make the second one feel more summery" : "Paste a store URL or ask anything"} />
          </PromptInputBody>
          <PromptInputFooter className="justify-end">
            <PromptInputSubmit status={status} disabled={busy} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}

function Pending({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" /> {label}
    </div>
  );
}
function ToolError({ text }: { text: string }) {
  return <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{text}</div>;
}
