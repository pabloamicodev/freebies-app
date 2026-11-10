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

describe("gift removed notice focus", () => {
  const open = () => {
    vi.useFakeTimers();
    window.__peGiftNotice!("Gift removed", "Close");
    vi.advanceTimersByTime(60);
  };

  it("hands focus back to where it was when the notice closes with focus inside", () => {
    document.body.insertAdjacentHTML("beforeend", '<button id="checkout">Checkout</button>');
    const checkout = document.getElementById("checkout") as HTMLButtonElement;
    checkout.focus();
    open();
    const close = box().querySelector("button")!;
    close.focus();
    box().dispatchEvent(new FocusEvent("focusin", { relatedTarget: checkout, bubbles: true }));
    close.click();
    expect(document.activeElement).toBe(checkout);
  });

  it("re-arms on focusout only when focus leaves the notice", () => {
    open();
    const close = box().querySelector("button")!;
    box().dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    box().dispatchEvent(new FocusEvent("focusout", { relatedTarget: close, bubbles: true }));
    vi.advanceTimersByTime(20_000);
    expect(box().hasAttribute("data-open")).toBe(true);
    box().dispatchEvent(new FocusEvent("focusout", { relatedTarget: document.body, bubbles: true }));
    vi.advanceTimersByTime(8_100);
    expect(box().hasAttribute("data-open")).toBe(false);
  });

  it("sits at the top so it never covers checkout buttons", () => {
    expect(document.head.querySelector("style")!.textContent).toMatch(/\.pe-gift-notice \{[^}]*top: 16px/);
  });
});
