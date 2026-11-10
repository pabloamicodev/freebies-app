/** Runs `fn` for every item, reporting a throw (or a `false` result) per item instead of stopping; returns how many failed. */
export async function runPerShop<T extends { domain: string }>(
  items: T[],
  fn: (item: T) => Promise<boolean>,
  report: (line: string) => void = console.error,
): Promise<number> {
  let failed = 0;
  for (const item of items) {
    try {
      if (!(await fn(item))) failed++;
    } catch (error) {
      failed++;
      report(`${item.domain}: FAILED ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failed;
}
