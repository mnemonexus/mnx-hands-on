/** Small animation helpers. All of them honour reduced motion by jumping straight to the end. */
import { reducedMotion } from './engine';

export const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Calls `step` with progress 0..1 over `ms` milliseconds, then `onEnd`. Returns a function that stops it early without
 * calling `onEnd`. With reduced motion it calls `step(1)` and `onEnd` at once.
 */
export function tween(ms: number, step: (t: number) => void, onEnd?: () => void, ease: (t: number) => number = easeInOut): () => void {
  if (reducedMotion() || ms <= 0) {
    step(1);
    onEnd?.();
    return () => undefined;
  }
  let frame = 0;
  let stopped = false;
  const start = performance.now();
  const tick = (now: number) => {
    if (stopped) return;
    const t = Math.min(1, (now - start) / ms);
    step(ease(t));
    if (t < 1) frame = requestAnimationFrame(tick);
    else onEnd?.();
  };
  frame = requestAnimationFrame(tick);
  return () => { stopped = true; cancelAnimationFrame(frame); };
}

/** Run `fn` at most once per animation frame, however often it is asked for. */
export function perFrame(fn: () => void): () => void {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fn(); });
  };
}
