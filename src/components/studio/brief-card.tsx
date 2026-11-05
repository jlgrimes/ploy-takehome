"use client";

import { useMemo, useState } from "react";
import { Check, Loader2, Quote, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CampaignState } from "@/lib/campaign-state";
import { ANGLES, type AngleKey, type Brief, type Provenance } from "@/lib/types";
import { cn } from "@/lib/utils";

const PROV: Record<Provenance, { label: string; cls: string }> = {
  scraped: { label: "From your site", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  inferred: { label: "Inferred", cls: "bg-sky-50 text-sky-700 border-sky-200" },
  user: { label: "Edited", cls: "bg-violet-50 text-violet-700 border-violet-200" },
  default: { label: "Default", cls: "bg-muted text-muted-foreground border-border" },
  missing: { label: "Not found", cls: "bg-amber-50 text-amber-800 border-amber-200" },
};

export function ProvBadge({ source }: { source?: Provenance }) {
  if (!source) return null;
  const p = PROV[source];
  return <span className={cn("rounded-full border px-1.5 py-px text-[10px] font-medium", p.cls)}>{p.label}</span>;
}

function Field({ label, badge, children, hint }: { label: string; badge?: React.ReactNode; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {label} {badge}
      </span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

const inputCls = "w-full rounded-lg border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring/40";

export function BriefCard({
  state,
  findings,
  note,
  readOnly,
  onConfirm,
}: {
  state: CampaignState;
  findings?: string;
  note?: string;
  readOnly?: boolean;
  onConfirm?: (brief: Brief, changes: string[]) => Promise<void>;
}) {
  const initial = state.campaign.brief;
  const [brief, setBrief] = useState<Brief | null>(initial);
  const [adjectives, setAdjectives] = useState(initial?.voice.adjectives.join(", ") ?? "");
  const [avoid, setAvoid] = useState(initial?.avoid.join(", ") ?? "");
  const [submitting, setSubmitting] = useState(false);
  const kit = state.kit;
  const prov = kit?.provenance ?? {};
  const primary = kit?.colors.find((c) => c.role === "primary")?.hex;

  const changes = useMemo(() => {
    if (!initial || !brief) return [];
    const out: string[] = [];
    if (brief.offer) out.push(`Offer: ${brief.offer}`);
    if (brief.cta !== initial.cta) out.push(`CTA: ${brief.cta}`);
    if (adjectives !== initial.voice.adjectives.join(", ")) out.push(`Voice: ${adjectives}`);
    if (brief.valueProp !== initial.valueProp) out.push("Edited value proposition");
    if (avoid.trim()) out.push(`Avoid: ${avoid}`);
    if (brief.concepts.length !== initial.concepts.length) out.push(`${brief.concepts.length} concepts`);
    brief.concepts.forEach((c, i) => {
      const before = initial.concepts.find((x) => x.productId === c.productId);
      if (before && before.angle !== c.angle) out.push(`${state.products[c.productId]?.title}: ${ANGLES[c.angle].label}`);
      void i;
    });
    return out;
  }, [initial, brief, adjectives, avoid, state.products]);

  if (!brief) return <div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">No brief yet.</div>;
  const set = (patch: Partial<Brief>) => setBrief({ ...brief, ...patch });
  const hasProof = state.facts.some((f) => f.kind === "rating" || f.kind === "review_count");

  const submit = async () => {
    if (!onConfirm) return;
    setSubmitting(true);
    try {
      await onConfirm(
        {
          ...brief,
          offer: brief.offer?.trim() || null,
          voice: { ...brief.voice, adjectives: adjectives.split(",").map((s) => s.trim()).filter(Boolean) },
          avoid: avoid.split(",").map((s) => s.trim()).filter(Boolean),
        },
        changes,
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="w-full overflow-hidden rounded-xl border bg-card">
      {/* brand kit */}
      <div className="flex items-center gap-3 border-b bg-muted/40 px-4 py-3">
        <div className="grid h-10 min-w-10 place-items-center overflow-hidden rounded-lg border bg-white px-2">
          {kit?.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={kit.logoUrl} alt="Logo" className="max-h-7 max-w-28 object-contain" />
          ) : (
            <span className="text-xs font-bold">{state.brand?.name?.slice(0, 2)}</span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{state.brand?.name}</p>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              Logo <ProvBadge source={prov.logo?.source} />
            </span>
            <span className="inline-flex items-center gap-1">
              {primary ? <span className="size-3 rounded-full border" style={{ background: primary }} /> : null}
              {primary} <ProvBadge source={prov.primary?.source} />
            </span>
            <span className="inline-flex items-center gap-1">
              {kit?.fonts[0]?.family ?? "Inter"} <ProvBadge source={prov.font?.source} />
            </span>
          </div>
        </div>
      </div>

      <div className="space-y-4 p-4">
        {findings ? <p className="text-sm text-muted-foreground">{findings}</p> : null}
        {note ? <p className="text-sm font-medium">{note}</p> : null}

        {/* concepts */}
        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground">Ads to make</p>
          <ul className="space-y-2">
            {brief.concepts.map((c, i) => {
              const p = state.products[c.productId];
              return (
                <li key={`${c.productId}-${i}`} className="flex items-center gap-3 rounded-lg border p-2">
                  <div className="size-14 shrink-0 overflow-hidden rounded-md bg-muted">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {p?.imageUrl ? <img src={p.imageUrl} alt={p.title} className="size-full object-cover" /> : null}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{p?.title ?? "Product"}</p>
                    <p className="line-clamp-2 text-xs text-muted-foreground">{c.why}</p>
                    <select
                      disabled={readOnly}
                      value={c.angle}
                      onChange={(e) => set({ concepts: brief.concepts.map((x, j) => (j === i ? { ...x, angle: e.target.value as AngleKey } : x)) })}
                      className="mt-1 rounded-md border bg-background px-1.5 py-0.5 text-xs"
                      aria-label="Angle"
                    >
                      {(Object.keys(ANGLES) as AngleKey[])
                        .filter((k) => (k !== "offer" || brief.offer) && (k !== "social_proof" || hasProof))
                        .map((k) => (
                          <option key={k} value={k}>
                            {ANGLES[k].label}
                          </option>
                        ))}
                    </select>
                  </div>
                  {!readOnly && brief.concepts.length > 1 ? (
                    <button type="button" onClick={() => set({ concepts: brief.concepts.filter((_, j) => j !== i) })} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Remove">
                      <X className="size-4" />
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>

        {/* claims */}
        {state.facts.length ? (
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">Claims the ads may use (verified on your site)</p>
            <ul className="flex flex-wrap gap-1.5">
              {state.facts.slice(0, 8).map((f) => (
                <li key={f.id} className="inline-flex items-center gap-1 rounded-full border bg-muted/40 px-2 py-0.5 text-xs">
                  <Quote className="size-3 text-muted-foreground" /> {f.text}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Offer" hint="Leave empty and ads won't mention any discount.">
            <input disabled={readOnly} value={brief.offer ?? ""} onChange={(e) => set({ offer: e.target.value })} placeholder="e.g. 20% off with code LOOP20" className={inputCls} />
          </Field>
          <Field label="Button text">
            <input disabled={readOnly} value={brief.cta} onChange={(e) => set({ cta: e.target.value })} className={inputCls} />
          </Field>
          <Field label="Brand voice" badge={<ProvBadge source={prov.voice?.source} />}>
            <input disabled={readOnly} value={adjectives} onChange={(e) => setAdjectives(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Never say" hint="Comma-separated words or claims.">
            <input disabled={readOnly} value={avoid} onChange={(e) => setAvoid(e.target.value)} placeholder="e.g. cheap, indestructible" className={inputCls} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Why people buy" badge={<ProvBadge source={prov.valueProp?.source} />}>
              <input disabled={readOnly} value={brief.valueProp} onChange={(e) => set({ valueProp: e.target.value })} className={inputCls} />
            </Field>
          </div>
        </div>

        {!readOnly ? (
          <div className="flex items-center justify-between gap-3 border-t pt-3">
            <p className="text-xs text-muted-foreground">{changes.length ? `${changes.length} change${changes.length > 1 ? "s" : ""}` : "Looks right? Nothing is generated until you confirm."}</p>
            <Button onClick={submit} disabled={submitting || !brief.concepts.length} className="rounded-lg">
              {submitting ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
              Generate {brief.concepts.length} ad{brief.concepts.length > 1 ? "s" : ""}
            </Button>
          </div>
        ) : (
          <p className="flex items-center gap-1.5 border-t pt-3 text-xs text-muted-foreground">
            <Check className="size-3.5 text-success" /> Brief confirmed
          </p>
        )}
      </div>
    </div>
  );
}
