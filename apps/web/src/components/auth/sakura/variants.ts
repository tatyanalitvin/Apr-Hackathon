// Central registry for sakura tree variants. Each variant pairs a builder
// (space-colonisation / L-system / custom tree-graph producer) with a
// renderer (how to paint the edges + petal clusters). Adding a new variant
// is a one-stop edit: drop a `vN-*.ts` file beside this one, import its
// build/render pair, and add an entry to `VARIANTS` below.

import type { Cluster, Edge, Point } from "./core";
import { lSystemTree, readThemeColors, spaceColonize } from "./core";
import { renderV1 } from "./v1-layered";
import { buildWeepingTree, renderV2 } from "./v2-weeping";
import { buildWindsweptTree, renderV3 } from "./v3-windswept";
import { renderV4 } from "./v4-stylized";
import { buildSlimTree, renderV5 } from "./v5-slim";
import { buildFullBloomTree, renderV6 } from "./v6-fullbloom";

export type VariantKey = "v1" | "v2" | "v3" | "v4" | "v5" | "v6";

export type VariantRenderer = (
  tctx: CanvasRenderingContext2D,
  edges: Edge[], clusters: Cluster[],
  colors: ReturnType<typeof readThemeColors>,
  height: number, renderRng: () => number,
) => void;

export type VariantBuilder = (
  width: number, height: number, rng: () => number,
) => { edges: Edge[]; tips: Point[] };

export type Variant = {
  build: VariantBuilder;
  render: VariantRenderer;
};

export const VARIANTS: Record<VariantKey, Variant> = {
  v1: { build: (w, h, r) => spaceColonize(w, h, r), render: renderV1 },
  v2: { build: buildWeepingTree, render: renderV2 },
  v3: { build: buildWindsweptTree, render: renderV3 },
  v4: { build: (w, h, r) => lSystemTree(w, h, r), render: renderV4 },
  v5: { build: buildSlimTree, render: renderV5 },
  v6: { build: buildFullBloomTree, render: renderV6 },
};

export const VARIANT_KEYS = Object.keys(VARIANTS) as VariantKey[];

export function isVariantKey(value: string | null | undefined): value is VariantKey {
  return typeof value === "string" && (VARIANT_KEYS as string[]).includes(value);
}
