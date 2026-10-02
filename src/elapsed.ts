/** One monotonic clock per launch attempt; progress updates never reset it. */
export function startElapsed(redraw: () => void, now = () => performance.now()) {
  const started = now();
  const timer = setInterval(redraw, 1000);
  timer.unref();
  return {
    seconds: () => Math.max(0, Math.floor((now() - started) / 1000)),
    stop: () => clearInterval(timer),
  };
}
