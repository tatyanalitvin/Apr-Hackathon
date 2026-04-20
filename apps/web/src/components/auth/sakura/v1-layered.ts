import {
  type Edge, type Cluster, type ThemeColors,
  mulberry32, valueNoise, drawBranchCurve,
} from "./core";

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

export function drawLayeredCluster(
  ctx: CanvasRenderingContext2D, c: Cluster, colors: ThemeColors,
) {
  const rng = mulberry32(c.seed);
  const { x, y, radius } = c;

  ctx.save();
  ctx.globalAlpha = 0.55;
  const shadow = ctx.createRadialGradient(x + 4, y + 5, 0, x + 4, y + 5, radius * 1.15);
  shadow.addColorStop(0, colors.shadow);
  shadow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = shadow;
  ctx.beginPath();
  ctx.arc(x + 4, y + 5, radius * 1.15, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = 0.35;
  const wash = ctx.createRadialGradient(x, y, 0, x, y, radius);
  wash.addColorStop(0, colors.petalLight);
  wash.addColorStop(0.6, colors.petalMid);
  wash.addColorStop(1, "rgba(255, 210, 228, 0)");
  ctx.fillStyle = wash;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const passes: [number, number, string][] = [
    [10 + Math.floor(rng() * 6), 2.6, colors.petalDeep],
    [18 + Math.floor(rng() * 10), 3, colors.petalMid],
    [14 + Math.floor(rng() * 8), 2.2, colors.petalLight],
  ];
  let seedOffset = 0;
  for (const [count, baseSize, fill] of passes) {
    for (let i = 0; i < count; i++) {
      const theta = rng() * Math.PI * 2;
      const rn = valueNoise(Math.cos(theta) * (2 + seedOffset) + c.seed * 0.01, Math.sin(theta) * (2 + seedOffset));
      const r = (0.15 + rn * 0.82) * radius;
      const px = x + Math.cos(theta) * r;
      const py = y + Math.sin(theta) * r * 0.9;
      drawMiniFlower(ctx, px, py, baseSize + rng() * 2, rng() * Math.PI * 2, fill);
    }
    seedOffset++;
  }

  const sparkCount = 4 + Math.floor(rng() * 4);
  for (let i = 0; i < sparkCount; i++) {
    const theta = rng() * Math.PI * 2;
    const r = rng() * radius * 0.7;
    ctx.save();
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = colors.highlight;
    ctx.beginPath();
    ctx.arc(x + Math.cos(theta) * r, y + Math.sin(theta) * r, 0.8 + rng() * 0.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

export function renderV1(
  tctx: CanvasRenderingContext2D,
  edges: Edge[], clusters: Cluster[],
  colors: ThemeColors, height: number, renderRng: () => number,
) {
  tctx.lineCap = "round";
  tctx.lineJoin = "round";

  const barkGradient = tctx.createLinearGradient(0, height + 20, 0, height * 0.15);
  barkGradient.addColorStop(0, colors.barkDark);
  barkGradient.addColorStop(0.55, colors.barkMid);
  barkGradient.addColorStop(1, colors.barkTip);
  tctx.strokeStyle = barkGradient;

  const sorted = [...edges].sort((a, b) => b.w - a.w);
  for (const e of sorted) drawBranchCurve(tctx, e, renderRng);

  for (const c of clusters) drawLayeredCluster(tctx, c, colors);
  tctx.globalAlpha = 1;
}
