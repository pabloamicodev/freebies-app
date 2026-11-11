import { AsyncLocalStorage } from "node:async_hooks";

export type CapacitySource = "admin" | "mcp" | "cron" | "background" | "webhook" | "auth";

export interface CapacityCaller {
  source: CapacitySource;
  /** A person is watching the result (modal / tool response); unattended blocks alert Sentry. */
  attended: boolean;
}

const store = new AsyncLocalStorage<CapacityCaller>();

/** Who triggered the publish the block happened in; anything outside a scope is an unattended background run. */
export function currentCapacityCaller(): CapacityCaller {
  return store.getStore() ?? { source: "background", attended: false };
}

export function runWithCapacitySource<T>(source: CapacitySource, attended: boolean, fn: () => T): T {
  return store.run({ source, attended }, fn);
}
