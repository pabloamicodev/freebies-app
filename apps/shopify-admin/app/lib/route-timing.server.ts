import { performance } from "node:perf_hooks";

type RouteTimingEntry = {
  name: string;
  durationMs: number;
};

function roundMs(value: number) {
  return Math.round(value * 10) / 10;
}

function shouldLogRouteTimings() {
  return process.env.NODE_ENV !== "production" || process.env["LOG_ROUTE_TIMINGS"] === "true";
}

export function createRouteTimer(route: string) {
  const startedAt = performance.now();
  const entries: RouteTimingEntry[] = [];

  async function time<T>(name: string, work: () => Promise<T> | T): Promise<T> {
    const queryStartedAt = performance.now();
    try {
      return await work();
    } finally {
      entries.push({
        name,
        durationMs: roundMs(performance.now() - queryStartedAt),
      });
    }
  }

  function done(metadata: Record<string, unknown> = {}) {
    if (!shouldLogRouteTimings()) return;

    console.info("[route-timing]", {
      route,
      totalMs: roundMs(performance.now() - startedAt),
      entries,
      ...metadata,
    });
  }

  return { time, done };
}
