export type Point = { x: number; y: number };
export type Edge = { p: Point; c: Point; w: number };
export type Cluster = { x: number; y: number; radius: number; seed: number };
export type ThemeColors = ReturnType<typeof readThemeColors>;

export type Petal = {
  x: number; y: number;
  vx: number; vy: number;
  rot: number; rotVel: number;
  flutter: number; flutterRate: number;
  size: number; alpha: number; life: number; maxLife: number;
};

export function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(x: number, y: number) {
  const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return n - Math.floor(n);
}
function smooth(t: number) { return t * t * (3 - 2 * t); }
export function valueNoise(x: number, y: number) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  const u = smooth(fx), v = smooth(fy);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

type SCNode = {
  x: number; y: number;
  parent: number;
  dx: number; dy: number; influenced: number;
  childCount: number;
};

export type SCAOptions = {
  attractorCount?: number;
  segLen?: number;
  killDist?: number;
  infDist?: number;
  maxIters?: number;
  canopyScale?: number;
};

export function spaceColonize(
  width: number, height: number, rng: () => number,
  opts: SCAOptions = {},
): { edges: Edge[]; tips: Point[] } {
  const attractorCount = opts.attractorCount ?? 520;
  const segLen = opts.segLen ?? 7;
  const killDist = opts.killDist ?? 13;
  const infDist = opts.infDist ?? 46;
  const maxIters = opts.maxIters ?? 240;
  const canopyScale = opts.canopyScale ?? 1;

  const trunkX = width * 0.5 + (rng() - 0.5) * width * 0.04;
  const baseY = height + 14;
  const canopyCx = trunkX + (rng() - 0.5) * width * 0.05;
  const canopyCy = Math.max(height * 0.34, 160);
  const canopyRx = Math.min(width * 0.46, 300) * canopyScale;
  const canopyRy = Math.min(height * 0.34, 230) * canopyScale;

  const nodes: SCNode[] = [{ x: trunkX, y: baseY, parent: -1, dx: 0, dy: 0, influenced: 0, childCount: 0 }];

  const trunkReach = baseY - (canopyCy + canopyRy * 0.25);
  const trunkSegs = Math.max(6, Math.floor(trunkReach / segLen));
  let cur = 0;
  for (let i = 0; i < trunkSegs; i++) {
    const prev = nodes[cur]!;
    const wobble = (rng() - 0.5) * 0.35;
    nodes.push({
      x: prev.x + Math.sin(i * 0.55) * 0.9 + wobble,
      y: prev.y - segLen,
      parent: cur, dx: 0, dy: 0, influenced: 0, childCount: 0,
    });
    prev.childCount = 1;
    cur = nodes.length - 1;
  }

  const attractors: { x: number; y: number; alive: boolean }[] = [];
  let tries = 0;
  while (attractors.length < attractorCount && tries < attractorCount * 6) {
    tries++;
    const ax = canopyCx + (rng() - 0.5) * 2 * canopyRx;
    const ay = canopyCy + (rng() - 0.5) * 2 * canopyRy;
    const ndx = (ax - canopyCx) / canopyRx;
    const ndy = (ay - canopyCy) / canopyRy;
    if (ndx * ndx + ndy * ndy > 1) continue;
    const lobeNoise = valueNoise(ax * 0.012, ay * 0.012);
    if (lobeNoise < 0.35) continue;
    attractors.push({ x: ax, y: ay, alive: true });
  }

  const kd2 = killDist * killDist;
  const id2 = infDist * infDist;

  for (const a of attractors) {
    for (const n of nodes) {
      const dx = a.x - n.x, dy = a.y - n.y;
      if (dx * dx + dy * dy < kd2) { a.alive = false; break; }
    }
  }

  for (let iter = 0; iter < maxIters; iter++) {
    let influenced = false;

    for (const a of attractors) {
      if (!a.alive) continue;
      let best = -1, bestD = id2;
      for (let i = 0; i < nodes.length; i++) {
        const nd = nodes[i]!;
        const dx = a.x - nd.x, dy = a.y - nd.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD) { bestD = d2; best = i; }
      }
      if (best >= 0) {
        const n = nodes[best]!;
        const dx = a.x - n.x, dy = a.y - n.y;
        const L = Math.sqrt(dx * dx + dy * dy) || 1;
        n.dx += dx / L;
        n.dy += dy / L;
        n.influenced += 1;
        influenced = true;
      }
    }

    if (!influenced) break;

    const parentsToGrow: number[] = [];
    const initialLen = nodes.length;
    for (let i = 0; i < initialLen; i++) if (nodes[i]!.influenced > 0) parentsToGrow.push(i);

    for (const pi of parentsToGrow) {
      const p = nodes[pi]!;
      let dx = p.dx, dy = p.dy;
      const L = Math.sqrt(dx * dx + dy * dy) || 1;
      dx /= L; dy /= L;
      dx += (rng() - 0.5) * 0.3;
      dy += (rng() - 0.5) * 0.15;
      dy += 0.06;
      const L2 = Math.sqrt(dx * dx + dy * dy) || 1;
      dx /= L2; dy /= L2;
      nodes.push({
        x: p.x + dx * segLen,
        y: p.y + dy * segLen,
        parent: pi, dx: 0, dy: 0, influenced: 0, childCount: 0,
      });
      p.childCount += 1;
      p.dx = 0; p.dy = 0; p.influenced = 0;
    }

    for (const a of attractors) {
      if (!a.alive) continue;
      for (let i = initialLen; i < nodes.length; i++) {
        const nd = nodes[i]!;
        const dx = a.x - nd.x, dy = a.y - nd.y;
        if (dx * dx + dy * dy < kd2) { a.alive = false; break; }
      }
    }
  }

  const widths = new Array<number>(nodes.length).fill(1.2);
  for (let i = nodes.length - 1; i > 0; i--) {
    const n = nodes[i]!;
    if (n.parent >= 0) {
      const pw = widths[n.parent] ?? 1.2;
      const cw = widths[i] ?? 1.2;
      widths[n.parent] = Math.sqrt(pw * pw + cw * cw);
    }
  }
  const maxW = 11;
  for (let i = 0; i < widths.length; i++) widths[i] = Math.min(widths[i] ?? 1.2, maxW);

  const edges: Edge[] = [];
  const tips: Point[] = [];
  for (let i = 1; i < nodes.length; i++) {
    const n = nodes[i]!;
    const par = nodes[n.parent]!;
    edges.push({
      p: { x: par.x, y: par.y },
      c: { x: n.x, y: n.y },
      w: Math.max(1.1, widths[i] ?? 1.2),
    });
    if (n.childCount === 0) tips.push({ x: n.x, y: n.y });
  }

  return { edges, tips };
}

export type LSystemOptions = {
  lean?: number;
  trunkTiltBias?: number;
};

export function lSystemTree(
  width: number, height: number, rng: () => number,
  opts: LSystemOptions = {},
): { edges: Edge[]; tips: Point[] } {
  const lean = opts.lean ?? 0;
  const trunkTiltBias = opts.trunkTiltBias ?? 0;
  const edges: Edge[] = [];
  const tips: Point[] = [];
  const trunkX = width * 0.5 + (rng() - 0.5) * width * 0.04;
  const baseY = height + 14;
  const trunkTop = height * 0.52;

  const stack: { x: number; y: number; angle: number; length: number; depth: number; width: number }[] = [];
  const rootLen = baseY - trunkTop;
  stack.push({
    x: trunkX, y: baseY,
    angle: -Math.PI / 2 + trunkTiltBias,
    length: rootLen * 0.45, depth: 6, width: 9,
  });

  while (stack.length) {
    const s = stack.pop()!;
    const x2 = s.x + Math.cos(s.angle) * s.length;
    const y2 = s.y + Math.sin(s.angle) * s.length;
    edges.push({ p: { x: s.x, y: s.y }, c: { x: x2, y: y2 }, w: s.width });

    if (s.depth <= 0 || s.length < 10) {
      tips.push({ x: x2, y: y2 });
      continue;
    }

    const branchCount = 2 + (rng() > 0.6 ? 1 : 0);
    for (let i = 0; i < branchCount; i++) {
      const spread = (i / Math.max(1, branchCount - 1) - 0.5) * (0.9 + rng() * 0.3);
      const jitter = (rng() - 0.5) * 0.25;
      const gravity = 0.05 * (1 - s.depth / 6);
      const wind = lean * (1 - s.depth / 6);
      stack.push({
        x: x2, y: y2,
        angle: s.angle + spread + jitter + gravity + wind,
        length: s.length * (0.66 + rng() * 0.14),
        depth: s.depth - 1,
        width: Math.max(1.1, s.width * 0.66),
      });
    }
  }

  return { edges, tips };
}

export function buildClustersFromTips(
  tips: Point[], rng: () => number,
  opts: { mergeDist?: number; radiusBase?: number; radiusJitter?: number } = {},
): Cluster[] {
  const mergeDist = opts.mergeDist ?? 22;
  const radiusBase = opts.radiusBase ?? 16;
  const radiusJitter = opts.radiusJitter ?? 8;
  const clusters: Cluster[] = [];
  const merged = new Set<number>();
  const md2 = mergeDist * mergeDist;
  for (let i = 0; i < tips.length; i++) {
    if (merged.has(i)) continue;
    const ti = tips[i]!;
    let sx = ti.x, sy = ti.y, n = 1;
    for (let j = i + 1; j < tips.length; j++) {
      if (merged.has(j)) continue;
      const tj = tips[j]!;
      const dx = ti.x - tj.x, dy = ti.y - tj.y;
      if (dx * dx + dy * dy < md2) {
        sx += tj.x; sy += tj.y; n += 1;
        merged.add(j);
      }
    }
    clusters.push({
      x: sx / n,
      y: sy / n,
      radius: radiusBase + Math.min(14, n * 3) + rng() * radiusJitter,
      seed: Math.floor(rng() * 0xffffffff),
    });
  }
  return clusters;
}

export function readThemeColors() {
  const style = getComputedStyle(document.documentElement);
  const blossom = style.getPropertyValue("--blossom").trim() || "#E89EC4";
  const isDark = document.documentElement.classList.contains("dark");
  return {
    blossom,
    isDark,
    barkDark: isDark ? "rgba(18, 10, 28, 0.95)" : "rgba(58, 34, 72, 0.75)",
    barkMid: isDark ? "rgba(54, 36, 72, 0.88)" : "rgba(102, 72, 128, 0.55)",
    barkTip: isDark ? "rgba(86, 62, 108, 0.75)" : "rgba(138, 108, 164, 0.45)",
    inkDark: isDark ? "rgba(8, 4, 14, 0.95)" : "rgba(36, 20, 48, 0.85)",
    petalDeep: isDark ? "rgba(200, 128, 170, 0.85)" : "rgba(194, 108, 152, 0.85)",
    petalMid: isDark ? "rgba(244, 186, 214, 0.82)" : "rgba(224, 142, 184, 0.82)",
    petalLight: isDark ? "rgba(255, 218, 232, 0.85)" : "rgba(252, 206, 228, 0.85)",
    petalAirbrush: isDark ? "rgba(248, 196, 220, 1)" : "rgba(234, 158, 196, 1)",
    highlight: isDark ? "rgba(255, 238, 246, 0.85)" : "rgba(255, 252, 254, 0.95)",
    shadow: isDark ? "rgba(40, 18, 48, 0.35)" : "rgba(90, 30, 78, 0.22)",
    glow: isDark ? "rgba(255, 200, 222, 0.55)" : "rgba(255, 220, 236, 0.75)",
  };
}

export function seedPetal(
  p: Petal, clusters: Cluster[],
  width: number, height: number,
  spawnY?: number,
) {
  const pick = clusters.length
    ? clusters[Math.floor(Math.random() * clusters.length)]!
    : { x: width * Math.random(), y: 0, radius: 20 };
  const a = Math.random() * Math.PI * 2;
  const r = Math.random() * pick.radius * 0.8;
  p.x = pick.x + Math.cos(a) * r;
  p.y = spawnY ?? pick.y + Math.sin(a) * r * 0.5;
  p.vx = (Math.random() - 0.5) * 0.5;
  p.vy = 0.18 + Math.random() * 0.42;
  p.rot = Math.random() * Math.PI * 2;
  p.rotVel = (Math.random() - 0.5) * 0.045;
  p.flutter = Math.random() * Math.PI * 2;
  p.flutterRate = 0.04 + Math.random() * 0.05;
  p.size = 5 + Math.random() * 5;
  p.alpha = 0;
  p.life = 0;
  p.maxLife = 600 + Math.random() * 900;
  void height;
}

export function stepPetal(p: Petal, dt: number, now: number): boolean {
  const t = now * 0.0002;
  const nx = valueNoise(p.x * 0.004 + t, p.y * 0.004);
  const ny = valueNoise(p.x * 0.004, p.y * 0.004 + t * 0.7);
  const windAngle = nx * Math.PI * 2;
  const windMag = 0.25 + ny * 0.5;
  p.vx += Math.cos(windAngle) * windMag * 0.06 * dt;
  p.vy += 0.012 * dt;
  p.vx *= 0.985;
  p.vy = Math.min(p.vy, 1.8);
  p.flutter += p.flutterRate * dt;
  p.rot += p.rotVel * dt + Math.sin(p.flutter) * 0.02 * dt;
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  p.life += dt;
  const lifeFrac = p.life / p.maxLife;
  if (lifeFrac < 0.12) p.alpha = lifeFrac / 0.12;
  else if (lifeFrac > 0.85) p.alpha = Math.max(0, 1 - (lifeFrac - 0.85) / 0.15);
  else p.alpha = 1;
  return p.life >= p.maxLife;
}

export function drawPetal(
  ctx: CanvasRenderingContext2D, p: Petal, colors: ThemeColors,
) {
  const tilt = Math.cos(p.flutter);
  const ax = Math.max(0.18, Math.abs(tilt));
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.rot);
  ctx.scale(ax, 1);
  ctx.globalAlpha = p.alpha * (0.55 + ax * 0.45);
  ctx.fillStyle = colors.petalMid;
  ctx.beginPath();
  const s = p.size;
  ctx.moveTo(0, -s);
  ctx.bezierCurveTo(s * 0.7, -s * 0.7, s * 0.7, s * 0.7, 0, s);
  ctx.bezierCurveTo(-s * 0.7, s * 0.7, -s * 0.7, -s * 0.7, 0, -s);
  ctx.fill();
  ctx.globalAlpha = p.alpha * 0.35 * ax;
  ctx.fillStyle = colors.highlight;
  ctx.beginPath();
  ctx.ellipse(0, -s * 0.1, s * 0.22, s * 0.55, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export function drawBranchCurve(
  ctx: CanvasRenderingContext2D, e: Edge, rng: () => number,
) {
  const dx = e.c.x - e.p.x, dy = e.c.y - e.p.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = -dy / len, ny = dx / len;
  const offset = (rng() - 0.5) * len * 0.18;
  const midx = (e.p.x + e.c.x) / 2 + nx * offset;
  const midy = (e.p.y + e.c.y) / 2 + ny * offset;
  ctx.lineWidth = e.w;
  ctx.beginPath();
  ctx.moveTo(e.p.x, e.p.y);
  ctx.quadraticCurveTo(midx, midy, e.c.x, e.c.y);
  ctx.stroke();
}
