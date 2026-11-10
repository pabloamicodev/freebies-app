// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const box = () => document.querySelector<HTMLElement>(".pe-gift-notice")!;

describe("gift removed notice", () => {
  beforeAll(async () => {
    await import("./gift-notice.js");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is a polite status region that stays in the tree while closed and carries the copy once open", () => {
    vi.useFakeTimers();
    window.__peGiftNotice!("Gift removed", "Close");
    expect(box().getAttribute("role")).toBe("status");
    expect(box().hasAttribute("data-open")).toBe(false);
    expect(box().textContent).not.toContain("Gift removed");
    vi.advanceTimersByTime(60);
    expect(box().hasAttribute("data-open")).toBe(true);
    expect(box().textContent).toContain("Gift removed");
    expect(box().querySelector("button")!.getAttribute("aria-label")).toBe("Close");
  });

  it("auto-dismisses, and the dismiss button and Escape close it", () => {
    vi.useFakeTimers();
    const show = () => {
      window.__peGiftNotice!("Gift removed", "Close");
      vi.advanceTimersByTime(60);
    };
    show();
    vi.advanceTimersByTime(8_100);
    expect(box().hasAttribute("data-open")).toBe(false);
    show();
    box().querySelector("button")!.click();
    expect(box().hasAttribute("data-open")).toBe(false);
    show();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(box().hasAttribute("data-open")).toBe(false);
    expect(document.querySelectorAll(".pe-gift-notice")).toHaveLength(1);
  });

  it("pauses the timer while hovered and does not shift layout (fixed position, motion off for reduced-motion)", () => {
    vi.useFakeTimers();
    window.__peGiftNotice!("Gift removed", "Close");
    vi.advanceTimersByTime(60);
    box().dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(20_000);
    expect(box().hasAttribute("data-open")).toBe(true);
    const css = document.head.querySelector("style")!.textContent!;
    expect(css).toContain("position: fixed");
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{ \.pe-gift-notice \{ transition: none/);
  });
});
