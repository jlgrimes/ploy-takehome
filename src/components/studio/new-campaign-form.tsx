"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const EXAMPLES = ["loopycases.com", "liquiddeath.com", "allbirds.com"];

export function NewCampaignForm({ className }: { className?: string }) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = (value: string) => {
    setError(null);
    start(async () => {
      const res = await fetch("/api/campaigns", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: value }) });
      const json = await res.json();
      if (!res.ok) return setError(json.error ?? "Couldn't start. Try again.");
      router.push(`/c/${json.id}?start=${encodeURIComponent(json.url)}`);
    });
  };

  return (
    <div className={cn("w-full", className)}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) submit(url);
        }}
        className="flex items-center gap-2 rounded-2xl border bg-card p-2 shadow-sm focus-within:ring-2 focus-within:ring-ring/40"
      >
        <span className="pl-3 text-sm text-muted-foreground select-none">https://</span>
        <input
          autoFocus
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="yourstore.com"
          aria-label="Store URL"
          className="min-w-0 flex-1 bg-transparent py-2 text-base outline-none placeholder:text-muted-foreground/60"
        />
        <Button type="submit" size="lg" disabled={pending || !url.trim()} className="rounded-xl">
          {pending ? <Loader2 className="size-4 animate-spin" /> : <ArrowRight className="size-4" />}
          Create ads
        </Button>
      </form>
      {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span>Try</span>
        {EXAMPLES.map((ex) => (
          <button key={ex} type="button" disabled={pending} onClick={() => submit(ex)} className="rounded-full border bg-card px-3 py-1 transition hover:border-foreground/30 hover:text-foreground">
            {ex}
          </button>
        ))}
      </div>
    </div>
  );
}
