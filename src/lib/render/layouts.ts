import { AD_HEIGHT as H, AD_WIDTH as W } from "../constants";
import type { AngleKey } from "../types";

// A layout is the single source of truth for an ad's geometry. The SAME definition
// (1) builds the guide canvas sent to fal, telling it where the product sits and which
// areas must stay quiet, and (2) positions our text layer afterwards. They can't drift.

export const SAFE_TOP = 160; // interstitial close button + status bar
export const SAFE_BOTTOM = 120; // home indicator / bottom edge
export const SIDE = 72;

export type Rect = { left: number; top: number; width: number; height: number };
export type LayoutKey = "topHeadline" | "bottomStack";

export type Layout = {
  key: LayoutKey;
  label: string;
  product: Rect; // where the real product photo is placed (and pasted back)
  textRect: Rect; // where copy sits; measured for legibility
  zones: Rect[]; // quiet areas in the guide
  sceneHint: string; // how to describe the quiet areas to the image model
};

export const LAYOUTS: Record<LayoutKey, Layout> = {
  topHeadline: {
    key: "topHeadline",
    label: "Headline on top",
    product: { left: 90, top: 640, width: W - 180, height: 960 },
    textRect: { left: 0, top: SAFE_TOP, width: W, height: 460 },
    zones: [
      { left: 0, top: 0, width: W, height: 620 },
      { left: 0, top: 1620, width: W, height: H - 1620 },
    ],
    sceneHint:
      "The upper third is open, softly lit, uncluttered background (plain wall, sky or seamless backdrop). The bottom edge is a clean, simple surface.",
  },
  bottomStack: {
    key: "bottomStack",
    label: "Copy stacked at bottom",
    product: { left: 90, top: 200, width: W - 180, height: 1000 },
    textRect: { left: 0, top: 1180, width: W, height: H - 1180 - SAFE_BOTTOM },
    zones: [
      { left: 0, top: 0, width: W, height: 180 },
      { left: 0, top: 1180, width: W, height: H - 1180 },
    ],
    sceneHint:
      "The lower 40% of the frame is a calm, simple, slightly darker area (tabletop, fabric, soft shadow or out-of-focus floor) with no objects.",
  },
};

export function layoutForAngle(angle: AngleKey): LayoutKey {
  return angle === "social_proof" || angle === "lifestyle" || angle === "gift" ? "bottomStack" : "topHeadline";
}
