"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { ChevronLeft } from "lucide-react";
import type { CampaignState } from "@/lib/campaign-state";
import { useCampaignState } from "@/hooks/use-campaign-state";
import { cn } from "@/lib/utils";
import { AdBoard } from "./ad-board";
import { ChatPanel, type StudioMessage } from "./chat-panel";

export function Workspace({ initialState, initialMessages, startUrl }: { initialState: CampaignState; initialMessages: StudioMessage[]; startUrl: string | null }) {
  const id = initialState.campaign.id;
  const { state, refresh } = useCampaignState(id, initialState);
  const sendRef = useRef<(t: string) => void>(() => {});
  const registerSend = useCallback((fn: (t: string) => void) => {
    sendRef.current = fn;
  }, []);
  const [tab, setTab] = useState<"chat" | "ads">("chat");
  const sendToAgent = useCallback((t: string) => {
    sendRef.current(t);
    setTab("chat");
  }, []);

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-card px-3 sm:px-4">
        <Link href="/" className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="All campaigns">
          <ChevronLeft className="size-5" />
        </Link>
        {state.kit?.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={state.kit.logoUrl} alt="" className="h-6 max-w-24 object-contain" />
        ) : null}
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{state.brand?.name ?? state.brand?.domain}</p>
          <p className="truncate text-xs text-muted-foreground">{state.brand?.domain}</p>
        </div>
        <div className="ml-auto flex rounded-lg border p-0.5 text-sm lg:hidden">
          {(["chat", "ads"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={cn("rounded-md px-3 py-1 capitalize", tab === t ? "bg-foreground text-background" : "text-muted-foreground")}>
              {t === "ads" ? `Ads${state.ads.length ? ` (${state.ads.length})` : ""}` : "Chat"}
            </button>
          ))}
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className={cn("min-h-0 w-full flex-col border-r bg-background lg:flex lg:w-[440px] lg:shrink-0", tab === "chat" ? "flex" : "hidden")}>
          <ChatPanel campaignId={id} initialMessages={initialMessages} startUrl={startUrl} state={state} refresh={refresh} registerSend={registerSend} />
        </aside>
        <main className={cn("min-h-0 flex-1 overflow-y-auto bg-muted/30 lg:block", tab === "ads" ? "block" : "hidden")}>
          <AdBoard state={state} refresh={refresh} sendToAgent={sendToAgent} />
        </main>
      </div>
    </div>
  );
}
