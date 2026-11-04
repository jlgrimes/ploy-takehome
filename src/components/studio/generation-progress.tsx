"use client";

import { Check, Loader2, TriangleAlert } from "lucide-react";
import type { AdProgress } from "@/lib/generation/pipeline";
import { ANGLES } from "@/lib/types";

const LABEL: Record<string, string> = {
  queued: "Writing copy",
  generating_scene: "Building the scene",
  rendering: "Setting type",
  ready: "Ready",
  failed: "Failed",
};

export function GenerationProgress({ ads, done }: { ads: AdProgress[]; done: boolean }) {
  return (
    <div className="w-full rounded-xl border bg-card p-3.5">
      <p className="mb-2 flex items-center gap-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {done ? <Check className="size-3.5 text-success" /> : <Loader2 className="size-3.5 animate-spin" />}
        {done ? `${ads.filter((a) => a.status === "ready").length} ads ready` : "Generating ads"}
      </p>
      <ul className="grid grid-cols-3 gap-2">
        {ads.map((a) => (
          <li key={a.adId} className="min-w-0">
            <div className="relative aspect-[9/16] overflow-hidden rounded-lg border bg-muted">
              {a.renderUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={a.renderUrl} alt={a.headline ?? a.title} className="size-full object-cover" />
              ) : (
                <div className="absolute inset-0 animate-pulse bg-gradient-to-b from-muted to-muted-foreground/10" />
              )}
            </div>
            <p className="mt-1.5 truncate text-xs font-medium">{a.title}</p>
            <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
              {a.status === "failed" ? <TriangleAlert className="size-3 text-destructive" /> : a.status === "ready" ? null : <Loader2 className="size-3 animate-spin" />}
              {a.status === "ready" ? ANGLES[a.angle]?.label : (a.detail && a.status !== "failed" ? a.detail : LABEL[a.status])}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
