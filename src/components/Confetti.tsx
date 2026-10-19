// A short confetti burst when a submission goes through. ~1.5 s, no library,
// skipped entirely if Windows "Show animations" is off.

import { useEffect, useRef } from "react";
import { useStore } from "../lib/store.ts";

const COLORS = ["#3b6fd8", "#0f8a7e", "#f0b44c", "#d9540f", "#d92d20", "#7c3aed", "#16a34a"];

export function Confetti() {
  const stamp = useStore((s) => s.celebrate);
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!stamp || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = innerWidth * dpr;
    c.height = innerHeight * dpr;
    ctx.scale(dpr, dpr);
    const parts = Array.from({ length: 140 }, (_, i) => {
      const left = i % 2 === 0;
      const angle = (left ? -60 : -120) * (Math.PI / 180) + (Math.random() - 0.5) * 0.9;
      const speed = 9 + Math.random() * 8;
      return {
        x: left ? innerWidth * 0.08 : innerWidth * 0.92,
        y: innerHeight * 0.95,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        w: 6 + Math.random() * 6,
        h: 3 + Math.random() * 4,
        r: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.4,
        color: COLORS[i % COLORS.length],
      };
    });
    const start = performance.now();
    let raf = 0;
    const frame = (t: number) => {
      const el = t - start;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      ctx.globalAlpha = Math.max(0, 1 - Math.max(0, el - 1100) / 500);
      for (const p of parts) {
        p.vy += 0.32;
        p.vx *= 0.99;
        p.x += p.vx;
        p.y += p.vy;
        p.r += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.r);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (el < 1600) raf = requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, innerWidth, innerHeight);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [stamp]);

  return <canvas ref={ref} className="confetti" aria-hidden />;
}
