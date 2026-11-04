import "server-only";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { db, must } from "./db";
import { DEMO_USER_ID } from "./constants";

export type AssetKind = "logo" | "product_image" | "guide" | "scene" | "render" | "upload";

export type Asset = {
  id: string;
  kind: AssetKind;
  path: string;
  public_url: string;
  width: number | null;
  height: number | null;
  mime: string | null;
};

const BUCKET = "assets";

// Upload bytes to Storage and record an assets row. Every image the app keeps
// goes through here, so fal/Shopify URLs never need to stay alive.
export async function saveAsset(opts: {
  bytes: Buffer;
  kind: AssetKind;
  brandId: string;
  path: string; // relative to brand folder, e.g. "ads/<ad>/<variant>/scene.jpg"
  mime: string;
  sourceUrl?: string | null;
}): Promise<Asset> {
  const fullPath = `${opts.brandId}/${opts.path}`;
  const up = await db().storage.from(BUCKET).upload(fullPath, opts.bytes, {
    contentType: opts.mime,
    upsert: true,
    cacheControl: "31536000",
  });
  if (up.error) throw new Error(`storage upload ${fullPath}: ${up.error.message}`);
  const publicUrl = db().storage.from(BUCKET).getPublicUrl(fullPath).data.publicUrl;
  let width: number | null = null;
  let height: number | null = null;
  if (opts.mime.startsWith("image/") && opts.mime !== "image/svg+xml") {
    const meta = await sharp(opts.bytes).metadata().catch(() => null);
    width = meta?.width ?? null;
    height = meta?.height ?? null;
  }
  const row = must(
    await db()
      .from("assets")
      .upsert(
        {
          owner_id: DEMO_USER_ID,
          brand_id: opts.brandId,
          kind: opts.kind,
          path: fullPath,
          public_url: publicUrl,
          mime: opts.mime,
          width,
          height,
          bytes: opts.bytes.length,
          sha256: createHash("sha256").update(opts.bytes).digest("hex"),
          source_url: opts.sourceUrl ?? null,
        },
        { onConflict: "path" },
      )
      .select("id, kind, path, public_url, width, height, mime")
      .single(),
    "insert asset",
  );
  return row as unknown as Asset;
}

// Download a remote image (store CDN, fal output) and persist it.
export async function copyRemoteAsset(opts: {
  url: string;
  kind: AssetKind;
  brandId: string;
  path: string;
}): Promise<{ asset: Asset; bytes: Buffer }> {
  const res = await fetch(opts.url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`download ${opts.url}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const mime = res.headers.get("content-type")?.split(";")[0] ?? "image/jpeg";
  const asset = await saveAsset({ ...opts, bytes, mime, sourceUrl: opts.url });
  return { asset, bytes };
}
