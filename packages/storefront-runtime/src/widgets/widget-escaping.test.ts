import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

type Ctor = new () => Record<string, unknown> & { connectedCallback(): void };
const defined = new Map<string, Ctor>();

class FakeHTMLElement {
  shadowRoot: { innerHTML: string; querySelector: () => null; getElementById: () => null } | null = null;
  attrs: Record<string, string> = {};
  getAttribute(name: string) {
    return this.attrs[name] ?? null;
  }
  attachShadow() {
    this.shadowRoot = { innerHTML: "", querySelector: () => null, getElementById: () => null };
    return this.shadowRoot;
  }
}

beforeAll(async () => {
  vi.stubGlobal("HTMLElement", FakeHTMLElement);
  vi.stubGlobal("window", {
    location: { href: "https://s.example/" },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("customElements", {
    get: () => undefined,
    define: (name: string, ctor: Ctor) => void defined.set(name, ctor),
  });
  await import("./gift-icon.js");
  await import("./today-offer-block.js");
  await import("./cart-message.js");
});

afterEach(() => undefined);

const PAYLOAD = `"><img src=x onerror=alert(1)>`;

function mount(tag: string, attrs: Record<string, string> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const el = new (defined.get(tag)!)() as any;
  el.attrs = attrs;
  el.connectedCallback();
  return el;
}

describe("widgets escape quotes in every attribute and text interpolation", () => {
  it("gift icon: label, title and countdown cannot break out of attributes", () => {
    const el = mount("promo-gift-icon", { label: PAYLOAD, "offer-id": PAYLOAD, "countdown-seconds": "30" });
    el["render"]({ offerId: PAYLOAD, offerName: PAYLOAD });
    const html = el.shadowRoot.innerHTML;
    expect(html).not.toContain(`"><img`);
    expect(html).toContain("&quot;&gt;&lt;img");
  });

  it("gift thumbnail: gift title and image URL are quote-escaped", () => {
    const el = mount("promo-gift-thumbnail");
    el["render"]([{ title: PAYLOAD, imageUrl: `https://cdn.example/a.png?x='"onerror=alert(1)`, variantId: "1" }]);
    const html = el.shadowRoot.innerHTML;
    expect(html).not.toContain(`"><img`);
    expect(html).not.toContain("<img src=x");
    expect(html).toMatch(/src="https:\/\/cdn\.example\/a\.png\?x=%27%22onerror=alert\(1\)"/);
  });

  it("today offer block: title, offer id, badge and image URL are quote-escaped", () => {
    const el = mount("promo-today-offer-block", { title: PAYLOAD });
    el["render"]([
      { offerId: PAYLOAD, title: PAYLOAD, description: PAYLOAD, imageUrl: `https://cdn.example/a.png?"onerror="x`, badgeText: PAYLOAD },
    ]);
    const html = el.shadowRoot.innerHTML;
    expect(html).not.toContain(`"><img`);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain('src="https://cdn.example/a.png?%22onerror=%22x"');
  });

  it("cart message: message text is escaped", () => {
    const el = mount("promo-cart-message");
    el["render"]({ offerId: "o", widgetId: "w", message: PAYLOAD, type: "info", priority: 0 });
    expect(el.shadowRoot.innerHTML).not.toContain(`"><img`);
  });
});
