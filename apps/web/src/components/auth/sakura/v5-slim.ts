// Narrow-column sakura silhouette — tuned for the ~240px right aside on
// /rooms. The existing v1–v4 builds are balanced for a wide auth hero (~720px+
// wide); dropping them into a slim column clips the canopy or squashes the
// trunk. This variant keeps the same petal clustering/drawing primitives but
// reshapes the canopy to be taller than it is wide and uses lighter ink so it
// reads as atmosphere behind the glass aside, not a second hero.

import {
  type Edge, type Point, type Cluster, type ThemeColors,
  spaceColonize, drawBranchCurve,
} from "./core";
import { drawLayeredCluster } from "./v1-layered";

export function buildSlimTree(
  width: number, height: number, rng: () => number,
): { edges: Edge[]; tips: Point[] } {
  // Narrower canopy footprint + fewer attractors = a compact, vertical
  // silhouette that doesn't hug the glass borders at 240px. canopyScale
  // < 1 shrinks the existing canopy ellipse; attractorCount drops so the
  // branching stays legible at this width rather than turning into a
  // solid mass.
  return spaceColonize(width, height, rng, {
    attractorCount: 260,
    canopyScale: 0.72,
    maxIters: 180,
    segLen: 6,
    infDist: 38,
  });
}

export function renderV5(
  tctx: CanvasRenderingContext2D,
  edges: Edge[], clusters: Cluster[],
  colors: ThemeColors, height: number, renderRng: () => number,
) {
  tctx.lineCap = "round";
  tctx.lineJoin = "round";

  // Bark gradient is pulled toward barkMid (lighter) so the tree recedes
  // behind the glass rather than competing with it. The aside is hidden
  // below 1100px so we don't worry about the tree fighting the centre
  // hero on smaller viewports.
  const barkGradient = tctx.createLinearGradient(0, height + 20, 0, height * 0.12);
  barkGradient.addColorStop(0, colors.barkMid);
  barkGradient.addColorStop(0.6, colors.barkTip);
  barkGradient.addColorStop(1, colors.barkTip);
  tctx.strokeStyle = barkGradient;

  // Softer ink than v1/v2 so the branches read as silhouette, not line art.
  tctx.save();
  tctx.globalAlpha = 0.78;
  const sorted = [...edges].sort((a, b) => b.w - a.w);
  for (const e of sorted) drawBranchCurve(tctx, e, renderRng);
  tctx.restore();

  // Reuse v1's layered cluster painter — it already handles theme colours
  // and layered petal stamps, so the blooms match the rest of the brand.
  for (const c of clusters) drawLayeredCluster(tctx, c, colors);
  tctx.globalAlpha = 1;
}
