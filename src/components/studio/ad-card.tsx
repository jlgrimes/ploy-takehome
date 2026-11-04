"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Check, ChevronDown, Download, Expand, Loader2, MessageSquare, PenLine, RotateCcw, TriangleAlert, Type, Image as ImageIcon, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { AdView, VariantView } from "@/lib/campaign-state";
import { ANGLES } from "@/lib/types";
import { cn } from "@/lib/utils";

const ACTIVE = new Set(["queued", "generating_scene", "rendering"]);
const STEP: Record<string, string> = { queued: "Writing copy…", generating_scene: "Building the scene…", rendering: "Setting type…" };
const CHANGE: Record<string, { label: string; icon: React.ReactNode }> = {
  initial: { label: "First draft", icon: <Sparkles className="size-3" /> },
  copy_edit: { label: "Copy change", icon: <Type className="size-3" /> },
  scene_regen: { label: "New scene", icon: <ImageIcon className="size-3" /> },
  brief_change: { label: "Brief change", icon: <PenLine className="size-3" /> },
};

export function AdCard({ ad, index, onChanged, sendToAgent }: { ad: AdView; index: number; onChanged: () => void; sendToAgent: (text: string) => void }) {
  const versions = ad.variants;
  const latest = versions[versions.length - 1];
  const defaultSel = ad.approvedVariantId ?? [...versions].reverse().find((v) => v.status === "ready")?.id ?? latest?.id;
  const [selId, setSelId] = useState<string | undefined>(defaultSel);
  // Jump to a newly created version automatically (state reset during render,
  // React's recommended alternative to a setState-in-effect).
  const latestId = latest?.id;
  const [seenLatest, setSeenLatest] = useState(latestId);
  if (latestId !== seenLatest) {
    setSeenLatest(latestId);
    setSelId(latestId);
  }
  const sel = versions.find((v) => v.id === selId) ?? latest;
  const [mode, setMode] = useState<"none" | "edit" | "feedback">("none");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const approved = !!ad.approvedVariantId;
  const generating = !!latest && ACTIVE.has(latest.status);

  const act = async (body: object, ok?: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/ads/${ad.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error((await res.json()).error ?? "Request failed");
      if (ok) toast.success(ok);
      onChanged();
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className={cn("flex flex-col rounded-2xl border bg-card p-3 shadow-xs transition", approved && "border-emerald-300 ring-1 ring-emerald-200")}>
      <header className="mb-2 flex items-start justify-between gap-2 px-1">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            <span className="text-muted-foreground">{index + 1}.</span> {ad.product?.title ?? "Ad"}
          </p>
          <p className="text-xs text-muted-foreground">{ANGLES[ad.angle]?.label}</p>
        </div>
        <StatusPill ad={ad} generating={generating} />
      </header>

      {/* creative */}
      <div className="relative">
        <button type="button" onClick={() => sel?.renderUrl && setOpen(true)} className="group relative block aspect-[9/16] w-full overflow-hidden rounded-xl bg-muted" aria-label="Preview full screen">
          {sel?.renderUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={sel.renderUrl} alt={sel.copy?.headline ?? "Ad"} className="size-full object-cover" />
          ) : sel?.status === "failed" ? (
            <div className="grid size-full place-items-center p-6 text-center text-sm text-muted-foreground">
              <div>
                <TriangleAlert className="mx-auto mb-2 size-5 text-destructive" />
                {sel.error ?? "This version failed."}
              </div>
            </div>
          ) : (
            <div className="absolute inset-0 animate-pulse bg-gradient-to-b from-muted via-muted to-muted-foreground/10" />
          )}
          {sel?.renderUrl ? (
            <span className="absolute right-2 bottom-2 rounded-full bg-black/50 p-1.5 text-white opacity-0 transition group-hover:opacity-100">
              <Expand className="size-3.5" />
            </span>
          ) : null}
        </button>
        {generating && latest?.id !== sel?.id ? (
          <div className="absolute inset-x-2 top-2 flex items-center gap-1.5 rounded-lg bg-black/60 px-2.5 py-1.5 text-xs text-white backdrop-blur">
            <Loader2 className="size-3 animate-spin" /> v{latest.version}: {STEP[latest.status]}
          </div>
        ) : generating ? (
          <div className="absolute inset-x-2 bottom-2 flex items-center gap-1.5 rounded-lg bg-black/60 px-2.5 py-1.5 text-xs text-white backdrop-blur">
            <Loader2 className="size-3 animate-spin" /> {STEP[latest.status]}
          </div>
        ) : null}
      </div>

      {/* versions */}
      {versions.length > 1 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {versions.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => setSelId(v.id)}
              className={cn(
                "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs transition",
                v.id === sel?.id ? "border-foreground bg-foreground text-background" : "hover:border-foreground/40",
                v.status === "failed" && "text-destructive",
              )}
              title={CHANGE[v.changeType]?.label}
            >
              {CHANGE[v.changeType]?.icon} v{v.version}
              {ad.approvedVariantId === v.id ? <Check className="size-3" /> : null}
            </button>
          ))}
        </div>
      ) : null}
      {sel ? <VersionNote v={sel} /> : null}

      {/* actions */}
      <div className="mt-3 grid grid-cols-[1fr_auto_auto_auto] gap-1.5">
        {approved && ad.approvedVariantId === sel?.id ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => act({ action: "unapprove" })} className="border-emerald-300 text-emerald-700">
            <Check className="size-4" /> Approved
          </Button>
        ) : (
          <Button size="sm" disabled={busy || sel?.status !== "ready"} onClick={() => sel && act({ action: "approve", variantId: sel.id }, `Approved v${sel.version}`)}>
            <Check className="size-4" /> Approve{versions.length > 1 ? ` v${sel?.version}` : ""}
          </Button>
        )}
        <Button variant="outline" size="icon-sm" disabled={sel?.status !== "ready"} onClick={() => setMode(mode === "edit" ? "none" : "edit")} aria-label="Edit copy" title="Edit copy">
          <PenLine className="size-4" />
        </Button>
        <Button variant="outline" size="icon-sm" disabled={!latest || generating} onClick={() => setMode(mode === "feedback" ? "none" : "feedback")} aria-label="Give feedback" title="Ask the agent for changes">
          <MessageSquare className="size-4" />
        </Button>
        <Button variant="outline" size="icon-sm" asChild disabled={!sel?.renderUrl}>
          <a href={sel?.renderUrl ?? "#"} target="_blank" rel="noreferrer" download aria-label="Download" title="Open full-size image">
            <Download className="size-4" />
          </a>
        </Button>
      </div>

      {mode === "edit" && sel ? (
        <EditCopy
          v={sel}
          busy={busy}
          onCancel={() => setMode("none")}
          onSave={async (copy) => {
            setMode("none");
            await act({ action: "editCopy", variantId: sel.id, copy }, "Re-rendering with your copy");
          }}
        />
      ) : null}
      {mode === "feedback" ? (
        <FeedbackBox
          onSend={(text) => {
            setMode("none");
            sendToAgent(`Feedback on ad ${index + 1} (${ad.product?.title}${sel ? `, v${sel.version}` : ""}): ${text}`);
          }}
        />
      ) : null}
      {latest?.status === "failed" && !generating ? (
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => sendToAgent(`Ad ${index + 1} (${ad.product?.title}) failed. Please try it again.`)}>
          <RotateCcw className="size-4" /> Ask the agent to retry
        </Button>
      ) : null}
      {sel?.status === "ready" ? <HowItWasMade v={sel} /> : null}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[min(92vw,440px)] border-0 bg-transparent p-0 shadow-none" showCloseButton>
          <DialogTitle className="sr-only">Ad preview</DialogTitle>
          {/* Phone-sized preview: what the interstitial looks like on a device. */}
          <div className="overflow-hidden rounded-[2.2rem] border-[10px] border-neutral-900 bg-black shadow-2xl">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {sel?.renderUrl ? <img src={sel.renderUrl} alt="" className="block max-h-[82vh] w-full object-contain" /> : null}
          </div>
        </DialogContent>
      </Dialog>
    </article>
  );
}

function StatusPill({ ad, generating }: { ad: AdView; generating: boolean }) {
  const [label, cls] = generating
    ? ["Generating", "bg-sky-50 text-sky-700 border-sky-200"]
    : ad.status === "approved"
      ? ["Approved", "bg-emerald-50 text-emerald-700 border-emerald-200"]
      : ad.status === "failed"
        ? ["Failed", "bg-red-50 text-red-700 border-red-200"]
        : ad.status === "rejected"
          ? ["Rejected", "bg-muted text-muted-foreground"]
          : ["Needs review", "bg-amber-50 text-amber-800 border-amber-200"];
  return <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium", cls)}>{label}</span>;
}

function VersionNote({ v }: { v: VariantView }) {
  if (v.changeType === "initial" || !v.feedback) return null;
  return (
    <div className="mt-2 rounded-lg bg-muted/60 px-2.5 py-1.5 text-xs">
      <p className="font-medium">
        v{v.version} · {v.feedback.summary ?? CHANGE[v.changeType]?.label}
      </p>
      <p className="mt-0.5 line-clamp-2 text-muted-foreground">“{v.feedback.text}”</p>
    </div>
  );
}

function EditCopy({ v, busy, onSave, onCancel }: { v: VariantView; busy: boolean; onSave: (c: { headline: string; subline: string | null; cta: string }) => void; onCancel: () => void }) {
  const [headline, setHeadline] = useState(v.copy?.headline ?? "");
  const [subline, setSubline] = useState(v.copy?.subline ?? "");
  const [cta, setCta] = useState(v.copy?.cta ?? "");
  const cls = "w-full rounded-lg border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring/40";
  return (
    <form
      className="mt-3 space-y-2 rounded-xl border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ headline: headline.trim(), subline: subline.trim() || null, cta: cta.trim() });
      }}
    >
      <p className="text-xs text-muted-foreground">Same image, new text: re-renders in about a second.</p>
      <input value={headline} onChange={(e) => setHeadline(e.target.value)} maxLength={60} className={cls} aria-label="Headline" placeholder="Headline" />
      <input value={subline} onChange={(e) => setSubline(e.target.value)} maxLength={90} className={cls} aria-label="Subline" placeholder="Subline (optional)" />
      <input value={cta} onChange={(e) => setCta(e.target.value)} maxLength={24} className={cls} aria-label="Button" placeholder="Button" />
      {headline.length > 32 ? <p className="text-xs text-amber-700">Long headlines shrink. Under 32 characters reads best in 2 seconds.</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={busy || !headline.trim() || !cta.trim()}>
          Save as new version
        </Button>
      </div>
    </form>
  );
}

function FeedbackBox({ onSend }: { onSend: (t: string) => void }) {
  const [text, setText] = useState("");
  return (
    <form
      className="mt-3 flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) onSend(text.trim());
      }}
    >
      <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. warmer light, show it outdoors" className="min-w-0 flex-1 rounded-lg border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring/40" />
      <Button type="submit" size="sm" disabled={!text.trim()}>
        Send
      </Button>
    </form>
  );
}

function HowItWasMade({ v }: { v: VariantView }) {
  const gen = (v.gen ?? {}) as { strategy?: string; model?: string; ms?: number; error?: string | null; cutout?: boolean; pasteBack?: { aligned: boolean }; legibility?: { panel: boolean; scrimAlpha: number } };
  const qa = (v.qa ?? null) as { checked?: boolean; inventedText?: boolean; productMatches?: boolean; notes?: string } | null;
  const rows: [string, string][] = [];
  if (gen.strategy === "fal") rows.push(["Scene", `${gen.model?.replace("fal-ai/", "")} · ${Math.round((gen.ms ?? 0) / 1000)}s`]);
  else if (gen.strategy === "studio_fallback") rows.push(["Scene", `Studio backdrop (image model unavailable${gen.error ? `: ${gen.error.slice(0, 60)}` : ""})`]);
  else if (gen.strategy === "reused_scene") rows.push(["Scene", "Reused from previous version (copy-only change)"]);
  if (gen.pasteBack) rows.push(["Product", gen.pasteBack.aligned ? `Original store pixels restored${gen.cutout ? " (cutout)" : ""}` : "Model's rendering (couldn't align original)"]);
  if (qa?.checked) rows.push(["Checks", `${qa.inventedText ? "⚠ invented text" : "No invented text"} · ${qa.productMatches ? "product matches" : "⚠ product differs"}`]);
  if (gen.legibility) rows.push(["Legibility", gen.legibility.panel ? "Busy background: copy on a panel" : `Scrim ${Math.round(gen.legibility.scrimAlpha * 100)}% for 4.5:1 contrast`]);
  if (!rows.length) return null;
  return (
    <details className="group mt-2 rounded-lg px-1 text-xs text-muted-foreground">
      <summary className="flex cursor-pointer list-none items-center gap-1 py-1 hover:text-foreground">
        <ChevronDown className="size-3 transition group-open:rotate-180" /> How this was made
      </summary>
      <dl className="mt-1 space-y-1">
        {rows.map(([k, val]) => (
          <div key={k} className="grid grid-cols-[72px_1fr] gap-2">
            <dt className="font-medium text-foreground/80">{k}</dt>
            <dd>{val}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
