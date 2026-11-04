import "server-only";

// Storefronts serve real HTML to browsers; some block obvious bots. We present a
// normal browser UA and keep timeouts short so one slow endpoint can't stall research.
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

export type FetchResult = {
  ok: boolean;
  status: number; // 0 = network error / timeout
  url: string;
  text: string;
  headers: Headers | null;
  ms: number;
  error?: string;
};

export async function fetchText(url: string, opts: { timeoutMs?: number; json?: boolean } = {}): Promise<FetchResult> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": UA,
        accept: opts.json ? "application/json" : "text/html,application/xhtml+xml",
        "accept-language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 12_000),
      cache: "no-store",
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, url: res.url, text, headers: res.headers, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, status: 0, url, text: "", headers: null, ms: Date.now() - t0, error: (e as Error).message };
  }
}

export async function fetchJson<T>(url: string, timeoutMs = 12_000): Promise<{ data: T | null; res: FetchResult }> {
  const res = await fetchText(url, { timeoutMs, json: true });
  if (!res.ok) return { data: null, res };
  try {
    return { data: JSON.parse(res.text) as T, res };
  } catch {
    return { data: null, res };
  }
}

// Bot walls (Cloudflare etc.) answer 403/429/503 with an interstitial page.
export function looksBlocked(r: FetchResult): boolean {
  if ([403, 429, 503].includes(r.status)) return true;
  return /cf-chl|challenge-platform|Attention Required|captcha/i.test(r.text.slice(0, 6000));
}
