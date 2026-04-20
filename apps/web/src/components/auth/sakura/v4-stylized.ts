import {
  type Edge, type Cluster, type ThemeColors,
  mulberry32, drawBranchCurve,
} from "./core";

export function drawInkBouquet(
  ctx: CanvasRenderingContext2D, c: Cluster, colors: ThemeColors,
) {
  const rng = mulberry32(c.seed);
  const cx = c.x, cy = c.y;
  const radius = c.radius * 0.75;

  ctx.save();
  ctx.globalAlpha = 0.3;
  const shadow = ctx.createRadialGradient(cx + 2, cy + 3, 0, cx + 2, cy + 3, radius);
  shadow.addColorStop(0, colors.shadow);
  shadow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = shadow;
  ctx.beginPath();
  ctx.arc(cx + 2, cy + 3, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const flowerCount = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < flowerCount; i++) {
    const theta = rng() * Math.PI * 2;
    const r = rng() * radius * 0.55;
    const fx = cx + Math.cos(theta) * r;
    const fy = cy + Math.sin(theta) * r * 0.85;
    const size = 4.2 + rng() * 1.8;
    const rot = rng() * Math.PI * 2;
    const fill = i === 0 ? colors.petalMid : rng() < 0.5 ? colors.petalLight : colors.petalDeep;

    ctx.save();
    ctx.translate(fx, fy);
    ctx.rotate(rot);

    ctx.fillStyle = colors.shadow;
    ctx.globalAlpha = 0.25;
    for (let k = 0; k < 5; k++) {
      ctx.save();
      ctx.rotate((k * Math.PI * 2) / 5);
      ctx.beginPath();
      ctx.ellipse(0.6, -size * 0.55 + 0.6, size * 0.48, size * 0.9, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.globalAlpha = 0.95;
    ctx.fillStyle = fill;
    for (let k = 0; k < 5; k++) {
      ctx.save();
      ctx.rotate((k * Math.PI * 2) / 5);
      ctx.beginPath();
      ctx.ellipse(0, -size * 0.55, size * 0.46, size * 0.88, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.globalAlpha = 0.9;
    ctx.fillStyle = colors.inkDark;
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.18, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = 0.85;
    ctx.fillStyle = colors.highlight;
    for (let k = 0; k < 5; k++) {
      ctx.save();
      ctx.rotate((k * Math.PI * 2) / 5 + 0.3);
      ctx.beginPath();
      ctx.arc(0, -size * 0.25, 0.45, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.restore();
  }

  const budCount = 2 + Math.floor(rng() * 3);
  for (let i = 0; i < budCount; i++) {
    const theta = rng() * Math.PI * 2;
    const r = radius * (0.6 + rng() * 0.35);
    const bx = cx + Math.cos(theta) * r;
    const by = cy + Math.sin(theta) * r * 0.85;
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = colors.petalDeep;
    ctx.beginPath();
    ctx.arc(bx, by, 1.4 + rng() * 0.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

export function renderV4(
  tctx: CanvasRenderingContext2D,
  edges: Edge[], clusters: Cluster[],
  colors: ThemeColors, height: number, renderRng: () => number,
) {
  tctx.lineCap = "round";
  tctx.lineJoin = "round";

  const inkGradient = tctx.createLinearGradient(0, height + 20, 0, height * 0.1);
  inkGradient.addColorStop(0, colors.inkDark);
  inkGradient.addColorStop(0.7, colors.barkMid);
  inkGradient.addColorStop(1, colors.barkTip);
  tctx.strokeStyle = inkGradient;

  const sorted = [...edges].sort((a, b) => b.w - a.w);
  for (const e of sorted) {
    const thick: Edge = { p: e.p, c: e.c, w: e.w * 1.05 };
    drawBranchCurve(tctx, thick, renderRng);
  }

  tctx.globalAlpha = 1;
  for (const c of clusters) drawInkBouquet(tctx, c, colors);
}
