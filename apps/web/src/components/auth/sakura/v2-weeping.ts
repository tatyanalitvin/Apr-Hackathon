import {
  type Edge, type Point, type Cluster, type ThemeColors,
  spaceColonize, drawBranchCurve,
} from "./core";
import { drawLayeredCluster } from "./v1-layered";

export function buildWeepingTree(
  width: number, height: number, rng: () => number,
): { edges: Edge[]; tips: Point[] } {
  const base = spaceColonize(width, height, rng, {
    attractorCount: 420,
    canopyScale: 0.92,
    maxIters: 200,
  });

  const extraEdges: Edge[] = [];
  const droopTips: Point[] = [];

  for (const tip of base.tips) {
    const whips = 1 + Math.floor(rng() * 2);
    for (let w = 0; w < whips; w++) {
      let x = tip.x + (rng() - 0.5) * 5;
      let y = tip.y + 2;
      const segs = 5 + Math.floor(rng() * 4);
      const phase = rng() * Math.PI * 2;
      const swayAmp = 1.2 + rng() * 1.2;
      const xDrift = (rng() - 0.5) * 0.6;
      for (let s = 0; s < segs; s++) {
        const t = s + 1;
        const nx = x + xDrift + Math.sin(phase + t * 0.55) * swayAmp;
        const ny = y + 7 + t * 0.5;
        const w2 = Math.max(1, 2.2 - s * 0.22);
        extraEdges.push({ p: { x, y }, c: { x: nx, y: ny }, w: w2 });
        x = nx; y = ny;
      }
      droopTips.push({ x, y });
    }
  }

  return {
    edges: [...base.edges, ...extraEdges],
    tips: [...base.tips, ...droopTips],
  };
}

export function renderV2(
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
