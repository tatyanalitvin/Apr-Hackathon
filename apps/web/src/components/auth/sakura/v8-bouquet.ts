// v8-bouquet — very short stub trunk with a sprawling multi-lobe canopy that
// fills most of the column. The canopyScale is cranked up even higher than v7
// so the canopy ellipse balloons and the trunk reach (baseY - (canopyCy +
// canopyRy * 0.25)) collapses to a stub — the composition reads as a floating
// bouquet of blossoms rather than a tree with a visible stem.
//
// Different shape from v6 (tall + narrow) and v7 (dome): here the ballooned
// canopy reaches down into the lower half of the column, creating multiple
// bloom zones at different depths instead of one tidy dome.

import {
  type Edge, type Cluster, type ThemeColors, type Point,
  mulberry32, valueNoise, drawBranchCurve, spaceColonize,
} from "./core";

export function buildBouquetTree(
  width: number, height: number, rng: () => number,
): { edges: Edge[]; tips: Point[] } {
  // canopyScale 2.2 = canopy 2.2× the baseline radius, so the canopy extends
  // well past the midline and the remaining trunk is a short stub. More
  // attractors + shorter segLen so the ballooned canopy is densely branched.
  return spaceColonize(width, height, rng, {
    attractorCount: 560,
    canopyScale: 2.2,
    maxIters: 220,
    segLen: 5,
    infDist: 36,
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

// Bouquet cluster: higher-contrast centre (more petalDeep) so the individual
// bloom zones read as distinct flower bunches inside the larger bouquet.
function drawBouquetCluster(
  ctx: CanvasRenderingContext2D, c: Cluster, colors: ThemeColors,
) {
  const rng = mulberry32(c.seed);
  const { x, y, radius } = c;

  ctx.save();
  ctx.globalAlpha = 0.48;
  const wash = ctx.createRadialGradient(x, y, 0, x, y, radius * 1.3);
  wash.addColorStop(0, colors.petalLight);
  wash.addColorStop(0.5, colors.petalMid);
  wash.addColorStop(1, "rgba(255, 210, 228, 0)");
  ctx.fillStyle = wash;
  ctx.beginPath();
  ctx.arc(x, y, radius * 1.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const passes: [number, number, string][] = [
    [20 + Math.floor(rng() * 10), 2.8, colors.petalDeep],
    [32 + Math.floor(rng() * 14), 3.1, colors.petalMid],
    [24 + Math.floor(rng() * 12), 2.3, colors.petalLight],
  ];
  let seedOffset = 0;
  for (const [count, baseSize, fill] of passes) {
    for (let i = 0; i < count; i++) {
      const theta = rng() * Math.PI * 2;
      const rn = valueNoise(Math.cos(theta) * (2 + seedOffset) + c.seed * 0.01, Math.sin(theta) * (2 + seedOffset));
      const r = (0.12 + rn * 0.9) * radius;
      const px = x + Math.cos(theta) * r;
      const py = y + Math.sin(theta) * r * 0.92;
      drawMiniFlower(ctx, px, py, baseSize + rng() * 2, rng() * Math.PI * 2, fill);
    }
    seedOffset++;
  }

  const sparkCount = 6 + Math.floor(rng() * 4);
  for (let i = 0; i < sparkCount; i++) {
    const theta = rng() * Math.PI * 2;
    const r = rng() * radius * 0.85;
    ctx.save();
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = colors.highlight;
    ctx.beginPath();
    ctx.arc(x + Math.cos(theta) * r, y + Math.sin(theta) * r, 0.8 + rng() * 0.9, 0, Math.PI * 2);
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

  const barkGradient = tctx.createLinearGradient(0, height + 20, 0, height * 0.5);
  barkGradient.addColorStop(0, colors.barkMid);
  barkGradient.addColorStop(0.7, colors.barkTip);
  barkGradient.addColorStop(1, colors.barkTip);
  tctx.strokeStyle = barkGradient;

  tctx.save();
  tctx.globalAlpha = 0.72;
  const sorted = [...edges].sort((a, b) => b.w - a.w);
  for (const e of sorted) drawBranchCurve(tctx, e, renderRng);
  tctx.restore();

  for (const c of clusters) drawBouquetCluster(tctx, c, colors);
  tctx.globalAlpha = 1;
}
