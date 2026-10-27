import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MAIN = "https://cdn.shopify.com/extensions/abc/assets/promo-engine.js?v=1";
const CHUNK = "https://cdn.shopify.com/extensions/abc/assets/promo-engine-blocks.js?v=1";

interface FakeScript { src: string; onload?: () => void; onerror?: () => void }

let scripts: FakeScript[];
let win: Record<string, unknown>;

async function load() {
  vi.resetModules();
  return import("./blocks-loader.js");
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  scripts = [];
  win = {};
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", {
    currentScript: { src: MAIN },
    createElement: () => ({}) as FakeScript,
    head: { appendChild: (s: FakeScript) => scripts.push(s) },
  });
});

afterEach(() => vi.unstubAllGlobals());

function chunkRegisters(api: Record<string, unknown>) {
  win.__peBlocks = api;
  scripts[0]!.onload!();
}

describe("lazy FBT / bundle-builder blocks", () => {
  it("does not request the chunk until a block mounts", async () => {
    await load();
    expect(scripts).toHaveLength(0);
  });

  it("requests the chunk next to promo-engine.js once, then mounts through the real init", async () => {
    const { lazyInitFbtWidget, lazyInitBundleBuilder } = await load();
    const fbt = vi.fn();
    const bundle = vi.fn();
    const a = {} as HTMLElement;
    const b = {} as HTMLElement;
    lazyInitFbtWidget(a, { offerId: "o" } as never, "USD", "s");
    lazyInitBundleBuilder(b, { offerId: "o2" } as never, "s");
    expect(scripts).toHaveLength(1);
    expect(scripts[0]!.src).toBe(CHUNK);
    expect(fbt).not.toHaveBeenCalled();

    chunkRegisters({ initFbtWidget: fbt, initBundleBuilder: bundle });
    await flush();
    expect(fbt).toHaveBeenCalledWith(a, { offerId: "o" }, "USD", "s");
    expect(bundle).toHaveBeenCalledWith(b, { offerId: "o2" }, "s");
  });

  it("mounts without a request when the chunk is already registered, without a second request", async () => {
    const { lazyInitFbtWidget } = await load();
    const fbt = vi.fn();
    win.__peBlocks = { initFbtWidget: fbt, initBundleBuilder: vi.fn() };
    lazyInitFbtWidget({} as HTMLElement, {} as never, "EUR", "s");
    await flush();
    expect(scripts).toHaveLength(0);
    expect(fbt).toHaveBeenCalledTimes(1);
  });

  it("flags the container and allows a retry when the chunk fails to load", async () => {
    const { lazyInitFbtWidget } = await load();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const container = { setAttribute: vi.fn() } as unknown as HTMLElement;
    lazyInitFbtWidget(container, {} as never, "USD", "s");
    scripts[0]!.onerror!();
    await flush();
    expect(container.setAttribute).toHaveBeenCalledWith("data-promo-engine-error", "true");

    lazyInitFbtWidget(container, {} as never, "USD", "s");
    expect(scripts).toHaveLength(2);
  });

  it("flags the container when the script URL cannot be resolved", async () => {
    vi.stubGlobal("document", { currentScript: null, createElement: () => ({}), head: { appendChild: vi.fn() } });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { lazyInitBundleBuilder } = await load();
    const container = { setAttribute: vi.fn() } as unknown as HTMLElement;
    lazyInitBundleBuilder(container, {} as never, "s");
    await flush();
    expect(container.setAttribute).toHaveBeenCalledWith("data-promo-engine-error", "true");
  });
});
