"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CampaignState } from "@/lib/campaign-state";

const ACTIVE = new Set(["queued", "generating_scene", "rendering"]);

export function isBusy(s: CampaignState | null) {
  if (!s) return false;
  if (s.campaign.status === "researching" || s.campaign.status === "generating") return true;
  return s.ads.some((a) => a.status === "generating" || a.variants.some((v) => ACTIVE.has(v.status)));
}

// Server state for the workspace. Polls while anything is generating; otherwise
// idle until refresh() is called (the chat calls it when a tool part changes).
export function useCampaignState(id: string, initial: CampaignState) {
  const [state, setState] = useState<CampaignState>(initial);
  const inflight = useRef(false);
  const refresh = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const res = await fetch(`/api/campaigns/${id}`, { cache: "no-store" });
      if (res.ok) setState(await res.json());
    } finally {
      inflight.current = false;
    }
  }, [id]);

  const busy = isBusy(state);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(refresh, 2500);
    return () => clearInterval(t);
  }, [busy, refresh]);

  return { state, refresh, setState };
}
