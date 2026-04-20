import {
  type Edge, type Point, type Cluster, type ThemeColors,
  lSystemTree, drawBranchCurve,
} from "./core";
import { drawInkBouquet } from "./v4-stylized";

export function buildWindsweptTree(
  width: number, height: number, rng: () => number,
): { edges: Edge[]; tips: Point[] } {
  const { edges, tips } = lSystemTree(width, height, rng, {
    lean: 0.22,
    trunkTiltBias: 0.08,
  });
  const pts: Point[] = tips.map((t) => ({ x: t.x, y: t.y }));
  return { edges, tips: pts };
}

export function renderV3(
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
  for (const e of sorted) drawBranchCurve(tctx, e, renderRng);

  tctx.save();
  tctx.globalAlpha = 0.18;
  tctx.strokeStyle = colors.petalLight;
  tctx.lineWidth = 0.8;
  for (let i = 0; i < 14; i++) {
    const y = height * (0.15 + renderRng() * 0.55);
    const x1 = renderRng() * Math.min(80, (0.15 * height));
    const x2 = x1 + 90 + renderRng() * 60;
    tctx.beginPath();
    tctx.moveTo(x1, y);
    tctx.quadraticCurveTo((x1 + x2) / 2, y - 4, x2, y + 2);
    tctx.stroke();
  }
  tctx.restore();

  tctx.globalAlpha = 1;
  for (const c of clusters) drawInkBouquet(tctx, c, colors);
}
