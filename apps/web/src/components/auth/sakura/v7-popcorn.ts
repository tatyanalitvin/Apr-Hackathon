// v7-popcorn — instead of merging nearby branch tips into a few big clusters
// (the default buildClustersFromTips behaviour), this variant places a small
// blossom cluster at EVERY tip. The result is lots of small puffs instead of
// a few dense lobes — the "popcorn-covered branch" look of a yoshino cherry.

import {
  type Edge, type Cluster, type ThemeColors,
  mulberry32, valueNoise, drawBranchCurve, spaceColonize,
} from "./core";
import type { Point } from "./core";

export function buildPopcornTree(
  width: number, height: number, rng: () => number,
): { edges: Edge[]; tips: Point[] } {
  // More attractors → more branch tips → more little puffs when every tip
  // gets its own cluster. Narrow canopy keeps it in the 240px column.
  return spaceColonize(width, height, rng, {
    attractorCount: 380,
    canopyScale: 0.74,
    maxIters: 220,
    segLen: 5,
    infDist: 34,
  });
}

// Build one cluster per tip with no merging and small radii. The standard
// buildClustersFromTips is shared by v1–v4 so we keep that untouched and
// emit our own cluster list here.
export function buildPopcornClusters(tips: Point[], rng: () => number): Cluster[] {
  return tips.map((t) => ({
    x: t.x,
    y: t.y,
    radius: 7 + rng() * 5,
    seed: Math.floor(rng() * 0xffffffff),
  }));
}

function drawPuff(
  ctx: CanvasRenderingContext2D, c: Cluster, colors: ThemeColors,
) {
  const rng = mulberry32(c.seed);
  const { x, y, radius } = c;

  // Soft wash — small and tight; many of these overlap to form the canopy.
  ctx.save();
  ctx.globalAlpha = 0.55;
  const wash = ctx.createRadialGradient(x, y, 0, x, y, radius * 1.1);
  wash.addColorStop(0, colors.petalLight);
  wash.addColorStop(0.7, colors.petalMid);
  wash.addColorStop(1, "rgba(255, 210, 228, 0)");
  ctx.fillStyle = wash;
  ctx.beginPath();
  ctx.arc(x, y, radius * 1.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // 3–5 flowers per puff — enough density that the branch reads as bloom,
  // not dots. Centre flower slightly larger; outer petals smaller.
  const n = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const theta = rng() * Math.PI * 2;
    const r = rng() * radius * 0.7;
    const px = x + Math.cos(theta) * r;
    const py = y + Math.sin(theta) * r;
    const size = 1.8 + rng() * 1.2;
    const rot = rng() * Math.PI * 2;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(rot);
    ctx.fillStyle = i === 0 ? colors.petalDeep : (i % 2 ? colors.petalMid : colors.petalLight);
    for (let k = 0; k < 5; k++) {
      ctx.save();
      ctx.rotate((k * Math.PI * 2) / 5);
      ctx.beginPath();
      ctx.ellipse(0, -size * 0.55, size * 0.42, size * 0.82, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  // Single highlight glint.
  ctx.save();
  ctx.globalAlpha = 0.7;
  ctx.fillStyle = colors.highlight;
  ctx.beginPath();
  ctx.arc(x + (rng() - 0.5) * radius * 0.4, y + (rng() - 0.5) * radius * 0.4, 0.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  void valueNoise;
}

export function renderV7(
  tctx: CanvasRenderingContext2D,
  edges: Edge[], clusters: Cluster[],
  colors: ThemeColors, height: number, renderRng: () => number,
) {
  tctx.lineCap = "round";
  tctx.lineJoin = "round";

  const barkGradient = tctx.createLinearGradient(0, height + 20, 0, height * 0.12);
  barkGradient.addColorStop(0, colors.barkMid);
  barkGradient.addColorStop(0.6, colors.barkTip);
  barkGradient.addColorStop(1, colors.barkTip);
  tctx.strokeStyle = barkGradient;

  tctx.save();
  tctx.globalAlpha = 0.7;
  const sorted = [...edges].sort((a, b) => b.w - a.w);
  for (const e of sorted) drawBranchCurve(tctx, e, renderRng);
  tctx.restore();

  for (const c of clusters) drawPuff(tctx, c, colors);
  tctx.globalAlpha = 1;
}
