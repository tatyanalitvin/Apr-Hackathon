"use client";

import { useEffect, useRef } from "react";
import {
  type Cluster, type Edge, type Petal,
  mulberry32, buildClustersFromTips, drawPetal,
  lSystemTree, readThemeColors, seedPetal, spaceColonize, stepPetal,
} from "./sakura/core";
import { renderV1 } from "./sakura/v1-layered";
import { buildWeepingTree, renderV2 } from "./sakura/v2-weeping";
import { buildWindsweptTree, renderV3 } from "./sakura/v3-windswept";
import { renderV4 } from "./sakura/v4-stylized";
import { buildSlimTree, renderV5 } from "./sakura/v5-slim";
import { buildFullBloomTree, renderV6 } from "./sakura/v6-fullbloom";
import { buildPopcornTree, buildPopcornClusters, renderV7 } from "./sakura/v7-popcorn";
import { buildCascadeTree, renderV8 } from "./sakura/v8-cascade";

const TREE_SEED = 0x5a4b5a41;
const PETAL_COUNT = 60;
const TARGET_FPS = 30;
const FRAME_MS = 1000 / TARGET_FPS;

export type VariantKey = "v1" | "v2" | "v3" | "v4" | "v5" | "v6" | "v7" | "v8";

type Renderer = (
  tctx: CanvasRenderingContext2D,
  edges: Edge[], clusters: Cluster[],
  colors: ReturnType<typeof readThemeColors>,
  height: number, renderRng: () => number,
) => void;

type Variant = {
  build: (width: number, height: number, rng: () => number) => { edges: Edge[]; tips: { x: number; y: number }[] };
  render: Renderer;
  // Optional cluster builder override — v7 emits one small cluster per tip
  // instead of merging tips into bigger lobes the standard builder does.
  buildClusters?: (tips: { x: number; y: number }[], rng: () => number) => Cluster[];
};

const VARIANTS: Record<VariantKey, Variant> = {
  v1: { build: (w, h, r) => spaceColonize(w, h, r), render: renderV1 },
  v2: { build: buildWeepingTree, render: renderV2 },
  v3: { build: buildWindsweptTree, render: renderV3 },
  v4: { build: (w, h, r) => lSystemTree(w, h, r), render: renderV4 },
  v5: { build: buildSlimTree, render: renderV5 },
  v6: { build: buildFullBloomTree, render: renderV6 },
  v7: { build: buildPopcornTree, render: renderV7, buildClusters: buildPopcornClusters },
  v8: { build: buildCascadeTree, render: renderV8 },
};

const VARIANT_KEYS: VariantKey[] = ["v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8"];

function pickVariant(fallback: VariantKey): VariantKey {
  if (typeof window === "undefined") return fallback;
  const q = new URLSearchParams(window.location.search).get("sakura");
  if ((VARIANT_KEYS as string[]).includes(q ?? "")) return q as VariantKey;
  return fallback;
}

export function SakuraPetals({ variant: variantProp = "v1" }: { variant?: VariantKey } = {}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const variantKey = pickVariant(variantProp);
    const variant = VARIANTS[variantKey];
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let width = 0, height = 0, dpr = 1;
    let treeCanvas: HTMLCanvasElement | null = null;
    let clusters: Cluster[] = [];
    const petals: Petal[] = [];
    let rafId = 0;
    let lastFrame = 0;
    let paused = false;

    const buildPetals = () => {
      petals.length = 0;
      for (let i = 0; i < PETAL_COUNT; i++) {
        const p = {} as Petal;
        seedPetal(p, clusters, width, height, Math.random() * height);
        p.life = Math.random() * p.maxLife;
        p.alpha = 0.8;
        petals.push(p);
      }
    };

    const buildTree = () => {
      const colors = readThemeColors();
      const rng = mulberry32(TREE_SEED);
      const renderRng = mulberry32(TREE_SEED ^ 0xa3);
      const { edges, tips } = variant.build(width, height, rng);
      clusters = variant.buildClusters
        ? variant.buildClusters(tips, rng)
        : buildClustersFromTips(tips, rng);

      treeCanvas = document.createElement("canvas");
      treeCanvas.width = Math.max(1, Math.floor(width * dpr));
      treeCanvas.height = Math.max(1, Math.floor(height * dpr));
      const tctx = treeCanvas.getContext("2d");
      if (!tctx) return;
      tctx.scale(dpr, dpr);

      variant.render(tctx, edges, clusters, colors, height, renderRng);
    };

    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      width = Math.max(1, Math.floor(rect.width));
      height = Math.max(1, Math.floor(rect.height));
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      buildTree();
      buildPetals();
    };

    const step = (now: number) => {
      rafId = requestAnimationFrame(step);
      if (paused) return;
      if (now - lastFrame < FRAME_MS) return;
      const dt = Math.min(1.5, (now - lastFrame) / FRAME_MS);
      lastFrame = now;

      const colors = readThemeColors();

      ctx.clearRect(0, 0, width, height);
      if (treeCanvas) ctx.drawImage(treeCanvas, 0, 0, width, height);

      for (const p of petals) {
        const dead = stepPetal(p, dt, now);
        if (dead || p.y > height + 20 || p.x < -30 || p.x > width + 30) {
          seedPetal(p, clusters, width, height);
        }
        drawPetal(ctx, p, colors);
      }
    };

    resize();
    if (reducedMotion) {
      const colors = readThemeColors();
      ctx.clearRect(0, 0, width, height);
      if (treeCanvas) ctx.drawImage(treeCanvas, 0, 0, width, height);
      for (const p of petals) drawPetal(ctx, p, colors);
    } else {
      lastFrame = performance.now();
      rafId = requestAnimationFrame(step);
    }

    const onVisibility = () => { paused = document.hidden; };
    const onResize = () => { resize(); };
    const themeObserver = new MutationObserver(() => { buildTree(); });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(rafId);
      themeObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("resize", onResize);
    };
  }, [variantProp]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
  );
}
