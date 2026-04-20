// v8-cascade — weeping silhouette + dense blossoms on every drooping whip.
// v2 weeping is designed for the wide auth hero; this variant narrows the
// canopy to fit the 240px aside and hangs a fully-bloomed cluster on each
// drop tip, so the tree reads as a canopy of blossom curtains.

import {
  type Edge, type Cluster, type ThemeColors,
  mulberry32, valueNoise, drawBranchCurve, spaceColonize,
} from "./core";
import type { Point } from "./core";

export function buildCascadeTree(
  width: number, height: number, rng: () => number,
): { edges: Edge[]; tips: Point[] } {
  // Same slim canopy as v5/v6, then append weeping whips off every canopy
  // tip. The resulting `tips` array is the whip ends, so when the standard
  // buildClustersFromTips runs it drops blossom clusters on the drooping
  // ends rather than up in the canopy.
  const base = spaceColonize(width, height, rng, {
    attractorCount: 280,
    canopyScale: 0.7,
    maxIters: 180,
    segLen: 6,
    infDist: 38,
  });

  const extraEdges: Edge[] = [];
  const whipTips: Point[] = [];

  for (const tip of base.tips) {
    const whips = 1 + Math.floor(rng() * 2);
    for (let w = 0; w < whips; w++) {
      let x = tip.x + (rng() - 0.5) * 4;
      let y = tip.y + 2;
      const segs = 4 + Math.floor(rng() * 3);
      const phase = rng() * Math.PI * 2;
      const swayAmp = 1.0 + rng() * 0.9;
      const xDrift = (rng() - 0.5) * 0.5;
      for (let s = 0; s < segs; s++) {
        const t = s + 1;
        const nx = x + xDrift + Math.sin(phase + t * 0.55) * swayAmp;
        const ny = y + 6 + t * 0.4;
        const w2 = Math.max(1, 2.0 - s * 0.22);
        extraEdges.push({ p: { x, y }, c: { x: nx, y: ny }, w: w2 });
        x = nx; y = ny;
      }
      whipTips.push({ x, y });
    }
  }

  return {
    edges: [...base.edges, ...extraEdges],
    // Only keep the whip ends as tips so blossoms hang at the bottom of
    // each weeping strand — the namesake "cascade".
    tips: whipTips,
  };
}

function drawBloomCluster(
  ctx: CanvasRenderingContext2D, c: Cluster, colors: ThemeColors,
) {
  const rng = mulberry32(c.seed);
  const { x, y, radius } = c;

  // Bigger wash than v5/v6 so drooping blooms feel weighty at the end of
  // each whip.
  ctx.save();
  ctx.globalAlpha = 0.55;
  const wash = ctx.createRadialGradient(x, y, 0, x, y, radius * 1.4);
  wash.addColorStop(0, colors.petalLight);
  wash.addColorStop(0.55, colors.petalMid);
  wash.addColorStop(1, "rgba(255, 210, 228, 0)");
  ctx.fillStyle = wash;
  ctx.beginPath();
  ctx.arc(x, y, radius * 1.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const passes: [number, number, string][] = [
    [14 + Math.floor(rng() * 8), 2.6, colors.petalDeep],
    [24 + Math.floor(rng() * 12), 3.0, colors.petalMid],
    [18 + Math.floor(rng() * 10), 2.2, colors.petalLight],
  ];
  let seedOffset = 0;
  for (const [count, baseSize, fill] of passes) {
    for (let i = 0; i < count; i++) {
      const theta = rng() * Math.PI * 2;
      const rn = valueNoise(Math.cos(theta) * (2 + seedOffset) + c.seed * 0.01, Math.sin(theta) * (2 + seedOffset));
      const r = (0.15 + rn * 0.85) * radius;
      const px = x + Math.cos(theta) * r;
      const py = y + Math.sin(theta) * r * 0.95;
      const size = baseSize + rng() * 2;
      const rot = rng() * Math.PI * 2;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(rot);
      ctx.fillStyle = fill;
      for (let k = 0; k < 5; k++) {
        ctx.save();
        ctx.rotate((k * Math.PI * 2) / 5);
        ctx.beginPath();
        ctx.ellipse(0, -size * 0.55, size * 0.42, size * 0.8, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();
    }
    seedOffset++;
  }

  const sparkCount = 5 + Math.floor(rng() * 4);
  for (let i = 0; i < sparkCount; i++) {
    const theta = rng() * Math.PI * 2;
    const r = rng() * radius * 0.8;
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = colors.highlight;
    ctx.beginPath();
    ctx.arc(x + Math.cos(theta) * r, y + Math.sin(theta) * r, 0.9 + rng() * 0.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

export function renderV8(
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
  tctx.globalAlpha = 0.72;
  const sorted = [...edges].sort((a, b) => b.w - a.w);
  for (const e of sorted) drawBranchCurve(tctx, e, renderRng);
  tctx.restore();

  for (const c of clusters) drawBloomCluster(tctx, c, colors);
  tctx.globalAlpha = 1;
}
