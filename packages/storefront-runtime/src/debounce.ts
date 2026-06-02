/**
 * Debounce with leading/trailing and cancellation support.
 * Used to batch cart evaluation requests — 300ms after last cart change.
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  waitMs: number,
): { call: (...args: Parameters<T>) => void; cancel: () => void; flush: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Parameters<T> | null = null;

  function call(...args: Parameters<T>): void {
    lastArgs = args;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (lastArgs) fn(...lastArgs);
    }, waitMs);
  }

  function cancel(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function flush(): void {
    cancel();
    if (lastArgs) fn(...lastArgs);
  }

  return { call, cancel, flush };
}

/**
 * AbortController wrapper — cancel a pending fetch when a newer request arrives.
 */
export class AbortableRequest {
  private controller: AbortController | null = null;

  start(): AbortSignal {
    if (this.controller) this.controller.abort("superseded");
    this.controller = new AbortController();
    return this.controller.signal;
  }

  cancel(): void {
    if (this.controller) {
      this.controller.abort("cancelled");
      this.controller = null;
    }
  }
}
