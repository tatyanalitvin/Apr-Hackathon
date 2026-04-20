// v6-fullbloom — slim narrow-column silhouette with ~2× the petal density of
// v5 AND a much bigger canopy relative to the trunk. We push canopyScale up
// so the canopy ellipse balloons and eats into the trunk's vertical reach;
// the result is a short trunk + a dominant bloom head, not a smaller tree.

import {
  type Edge, type Cluster, type ThemeColors, type Point,
  mulberry32, valueNoise, drawBranchCurve, spaceColonize,
} from "./core";

export function buildFullBloomTree(
  width: number, height: number, rng: () => number,
): { edges: Edge[]; tips: Point[] } {
  // canopyScale 1.8 = canopy 1.8× the baseline radius on both axes. The
  // trunk length is computed as baseY - (canopyCy + canopyRy*0.25) inside
  // spaceColonize, so a bigger canopyRy automatically shortens the trunk.
  // More attractors so the bigger canopy has enough branch tips to support
  // dense blossom clusters throughout.
  return spaceColonize(width, height, rng, {
    attractorCount: 520,
    canopyScale: 1.8,
    maxIters: 220,
    segLen: 6,
    infDist: 40,
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

function drawFullBloomCluster(
  ctx: CanvasRenderingContext2D, c: Cluster, colors: ThemeColors,
) {
  const rng = mulberry32(c.seed);
  const { x, y, radius } = c;

  ctx.save();
  ctx.globalAlpha = 0.45;
  const wash = ctx.createRadialGradient(x, y, 0, x, y, radius * 1.35);
  wash.addColorStop(0, colors.petalLight);
  wash.addColorStop(0.55, colors.petalMid);
  wash.addColorStop(1, "rgba(255, 210, 228, 0)");
  ctx.fillStyle = wash;
  ctx.beginPath();
  ctx.arc(x, y, radius * 1.35, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const passes: [number, number, string][] = [
    [22 + Math.floor(rng() * 10), 2.8, colors.petalDeep],
    [36 + Math.floor(rng() * 16), 3.2, colors.petalMid],
    [28 + Math.floor(rng() * 14), 2.4, colors.petalLight],
  ];
  let seedOffset = 0;
  for (const [count, baseSize, fill] of passes) {
    for (let i = 0; i < count; i++) {
      const theta = rng() * Math.PI * 2;
      const rn = valueNoise(Math.cos(theta) * (2 + seedOffset) + c.seed * 0.01, Math.sin(theta) * (2 + seedOffset));
      const r = (0.12 + rn * 0.92) * radius;
      const px = x + Math.cos(theta) * r;
      const py = y + Math.sin(theta) * r * 0.92;
      drawMiniFlower(ctx, px, py, baseSize + rng() * 2, rng() * Math.PI * 2, fill);
    }
    seedOffset++;
  }

  const sparkCount = 8 + Math.floor(rng() * 6);
  for (let i = 0; i < sparkCount; i++) {
    const theta = rng() * Math.PI * 2;
    const r = rng() * radius * 0.9;
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = colors.highlight;
    ctx.beginPath();
    ctx.arc(x + Math.cos(theta) * r, y + Math.sin(theta) * r, 0.9 + rng() * 0.9, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

export function renderV6(
  tctx: CanvasRenderingContext2D,
  edges: Edge[], clusters: Cluster[],
  colors: ThemeColors, height: number, renderRng: () => number,
) {
  tctx.lineCap = "round";
  tctx.lineJoin = "round";

  const barkGradient = tctx.createLinearGradient(0, height + 20, 0, height * 0.35);
  barkGradient.addColorStop(0, colors.barkMid);
  barkGradient.addColorStop(0.6, colors.barkTip);
  barkGradient.addColorStop(1, colors.barkTip);
  tctx.strokeStyle = barkGradient;

  tctx.save();
  tctx.globalAlpha = 0.72;
  const sorted = [...edges].sort((a, b) => b.w - a.w);
  for (const e of sorted) drawBranchCurve(tctx, e, renderRng);
  tctx.restore();

  for (const c of clusters) drawFullBloomCluster(tctx, c, colors);
  tctx.globalAlpha = 1;
}
