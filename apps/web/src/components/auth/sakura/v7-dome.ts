// v7-dome — wide round canopy that fills the column horizontally with dense
// overlapping blossom clusters. Different shape than v6 (tall + narrow); v7
// pushes the canopy wider via a big canopyScale so the tree reads as a
// full-crown Japanese cherry, trunk shortened as a side-effect of the ballooning
// canopy ellipse (trunkReach = baseY - (canopyCy + canopyRy * 0.25)).
//
// The cluster painter is dense enough that neighbouring lobes overlap and
// the canopy blends into one pink cloud rather than discrete puffs.

import {
  type Edge, type Cluster, type ThemeColors, type Point,
  mulberry32, valueNoise, drawBranchCurve, spaceColonize,
} from "./core";

export function buildDomeTree(
  width: number, height: number, rng: () => number,
): { edges: Edge[]; tips: Point[] } {
  // canopyScale 2.0 = canopy 2× the baseline radius on both axes. Bigger
  // canopyRy eats into trunk length so the trunk ends up stubby and the
  // canopy dominates the column both horizontally and vertically.
  return spaceColonize(width, height, rng, {
    attractorCount: 560,
    canopyScale: 2.0,
    maxIters: 220,
    segLen: 5,
    infDist: 34,
  });
}

function drawMiniFlower(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, size: number, rot: number, fill: string,
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.fillStyle = fill;
  for (let i = 0; i < 5; i++) {
    ctx.save();
    ctx.rotate((i * Math.PI * 2) / 5);
    ctx.beginPath();
    ctx.ellipse(0, -size * 0.55, size * 0.42, size * 0.8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

// Dense cluster with a dominant pink mid-layer so overlapping clusters read
// as one continuous canopy — not individual lobes.
function drawDomeCluster(
  ctx: CanvasRenderingContext2D, c: Cluster, colors: ThemeColors,
) {
  const rng = mulberry32(c.seed);
  const { x, y, radius } = c;

  ctx.save();
  ctx.globalAlpha = 0.5;
  const wash = ctx.createRadialGradient(x, y, 0, x, y, radius * 1.5);
  wash.addColorStop(0, colors.petalLight);
  wash.addColorStop(0.5, colors.petalMid);
  wash.addColorStop(1, "rgba(255, 210, 228, 0)");
  ctx.fillStyle = wash;
  ctx.beginPath();
  ctx.arc(x, y, radius * 1.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const passes: [number, number, string][] = [
    [14 + Math.floor(rng() * 8), 2.6, colors.petalDeep],
    [30 + Math.floor(rng() * 14), 3.0, colors.petalMid],
    [22 + Math.floor(rng() * 12), 2.3, colors.petalLight],
  ];
  let seedOffset = 0;
  for (const [count, baseSize, fill] of passes) {
    for (let i = 0; i < count; i++) {
      const theta = rng() * Math.PI * 2;
      const rn = valueNoise(Math.cos(theta) * (2 + seedOffset) + c.seed * 0.01, Math.sin(theta) * (2 + seedOffset));
      const r = (0.1 + rn * 0.95) * radius;
      const px = x + Math.cos(theta) * r;
      const py = y + Math.sin(theta) * r * 0.9;
      drawMiniFlower(ctx, px, py, baseSize + rng() * 2, rng() * Math.PI * 2, fill);
    }
    seedOffset++;
  }
}

export function renderV7(
  tctx: CanvasRenderingContext2D,
  edges: Edge[], clusters: Cluster[],
  colors: ThemeColors, height: number, renderRng: () => number,
) {
  tctx.lineCap = "round";
  tctx.lineJoin = "round";

  const barkGradient = tctx.createLinearGradient(0, height + 20, 0, height * 0.4);
  barkGradient.addColorStop(0, colors.barkMid);
  barkGradient.addColorStop(0.6, colors.barkTip);
  barkGradient.addColorStop(1, colors.barkTip);
  tctx.strokeStyle = barkGradient;

  tctx.save();
  tctx.globalAlpha = 0.7;
  const sorted = [...edges].sort((a, b) => b.w - a.w);
  for (const e of sorted) drawBranchCurve(tctx, e, renderRng);
  tctx.restore();

  for (const c of clusters) drawDomeCluster(tctx, c, colors);
  tctx.globalAlpha = 1;
}
