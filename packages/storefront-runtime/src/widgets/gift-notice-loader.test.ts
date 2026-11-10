// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scripts = () => [...document.head.querySelectorAll<HTMLScriptElement>("script")].filter((s) => s.src.includes("gift-notice"));

describe("showGiftNotice loader", () => {
  let show: (m: string, c: string) => void;
  beforeEach(async () => {
    vi.resetModules();
    document.head.innerHTML = "";
    delete window.__peGiftNotice;
    Object.defineProperty(document, "currentScript", { value: { src: "https://cdn.test/promo-engine.js" }, configurable: true });
    show = (await import("./gift-prompt-loader.js")).showGiftNotice;
  });
  afterEach(() => {
    delete window.__peGiftNotice;
  });

  it("requests the asset once while loading and renders the latest message once on load", () => {
    show("first", "Close");
    show("second", "Close");
    expect(scripts()).toHaveLength(1);
    const render = vi.fn();
    window.__peGiftNotice = render;
    scripts()[0]!.dispatchEvent(new Event("load"));
    expect(render).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledWith("second", "Close");
  });

  it("retries on a later removal after a failed request", () => {
    show("a", "Close");
    scripts()[0]!.dispatchEvent(new Event("error"));
    expect(scripts()).toHaveLength(0);
    show("b", "Close");
    expect(scripts()).toHaveLength(1);
  });

  it("calls the registered renderer directly without another request", () => {
    const render = vi.fn();
    window.__peGiftNotice = render;
    show("x", "Close");
    expect(render).toHaveBeenCalledWith("x", "Close");
    expect(scripts()).toHaveLength(0);
  });
});
