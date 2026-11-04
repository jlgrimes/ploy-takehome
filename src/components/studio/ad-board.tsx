"use client";

import { ArrowLeft, Loader2, Search, Sparkles } from "lucide-react";
import type { CampaignState } from "@/lib/campaign-state";
import { AdCard } from "./ad-card";

export function AdBoard({ state, refresh, sendToAgent }: { state: CampaignState; refresh: () => void; sendToAgent: (t: string) => void }) {
  const { ads, campaign } = state;
  if (!ads.length) return <EmptyBoard state={state} />;
  const approved = ads.filter((a) => a.approvedVariantId).length;
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Ads</h2>
          <p className="text-sm text-muted-foreground">
            Full-screen 9:16 interstitials · {approved} of {ads.length} approved
          </p>
        </div>
        {approved === ads.length && ads.length ? (
          <p className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-sm text-emerald-700">All ads approved — ready for a campaign</p>
        ) : campaign.status === "generating" ? (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Generating…
          </p>
        ) : null}
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {ads.map((ad, i) => (
          <AdCard key={ad.id} ad={ad} index={i} onChanged={refresh} sendToAgent={sendToAgent} />
        ))}
      </div>
    </div>
  );
}

function EmptyBoard({ state }: { state: CampaignState }) {
  const s = state.campaign.status;
  const n = state.campaign.brief?.concepts.length ?? 3;
  if (s === "brief_pending")
    return (
      <Centered icon={<ArrowLeft className="size-5" />} title="Your brief is ready" body="Review it in the chat. Change anything that's off, then generate. Nothing is created until you confirm." />
    );
  if (s === "generating")
    return (
      <div className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6">
        <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold">
          <Loader2 className="size-4 animate-spin" /> Generating {n} ads
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: n }, (_, i) => (
            <div key={i} className="rounded-2xl border bg-card p-3">
              <div className="mb-2 h-9 w-2/3 animate-pulse rounded bg-muted" />
              <div className="aspect-[9/16] animate-pulse rounded-xl bg-muted" />
            </div>
          ))}
        </div>
      </div>
    );
  if (s === "researching" || s === "draft")
    return <Centered icon={<Search className="size-5" />} title={`Studying ${state.brand?.domain ?? "your store"}`} body="Reading your catalog, best sellers, logo, colors and reviews. Progress shows in the chat." spin />;
  return <Centered icon={<Sparkles className="size-5" />} title="No ads yet" body="Tell the agent what to make in the chat." />;
}

function Centered({ icon, title, body, spin }: { icon: React.ReactNode; title: string; body: string; spin?: boolean }) {
  return (
    <div className="grid h-full min-h-[50vh] place-items-center p-8">
      <div className="max-w-sm text-center">
        <div className="mx-auto mb-3 grid size-10 place-items-center rounded-full border bg-card text-muted-foreground">{spin ? <Loader2 className="size-5 animate-spin" /> : icon}</div>
        <h2 className="font-medium">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}
