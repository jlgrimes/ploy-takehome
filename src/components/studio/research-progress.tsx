"use client";

import { AlertTriangle, Check, Circle, Loader2, MinusCircle } from "lucide-react";
import type { ResearchStep } from "@/lib/types";
import { cn } from "@/lib/utils";

const ICON = {
  running: <Loader2 className="size-3.5 animate-spin text-brand" />,
  ok: <Check className="size-3.5 text-success" />,
  degraded: <AlertTriangle className="size-3.5 text-warning" />,
  failed: <AlertTriangle className="size-3.5 text-destructive" />,
  skipped: <MinusCircle className="size-3.5 text-muted-foreground" />,
};

export function ResearchProgress({ steps, done, title }: { steps: ResearchStep[]; done: boolean; title?: string }) {
  return (
    <div className="w-full rounded-xl border bg-card p-3.5">
      <p className="mb-2 flex items-center gap-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {done ? <Check className="size-3.5 text-success" /> : <Loader2 className="size-3.5 animate-spin" />}
        {title ?? (done ? "Research complete" : "Researching store")}
      </p>
      <ol className="space-y-1.5">
        {steps.length === 0 ? (
          <li className="flex items-center gap-2 text-sm text-muted-foreground">
            <Circle className="size-3.5" /> Starting…
          </li>
        ) : (
          steps.map((s) => (
            <li key={s.key} className="flex items-start gap-2 text-sm">
              <span className="mt-0.5 shrink-0">{ICON[s.status]}</span>
              <span className="min-w-0">
                <span className={cn(s.status === "running" ? "text-foreground" : "text-foreground/90")}>{s.label}</span>
                {s.detail ? <span className={cn("block truncate text-xs", s.status === "degraded" || s.status === "failed" ? "text-warning-foreground text-amber-700" : "text-muted-foreground")}>{s.detail}</span> : null}
              </span>
            </li>
          ))
        )}
      </ol>
    </div>
  );
}
