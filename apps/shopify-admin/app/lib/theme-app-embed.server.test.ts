import { describe, expect, it } from "vitest";
import { detectPromoEngineEmbedStatus } from "./theme-app-embed.server.js";

function settings(blocks: Record<string, unknown>): string {
  return JSON.stringify({ current: { blocks } });
}

describe("detectPromoEngineEmbedStatus", () => {
  it("detects an enabled Promo Engine app embed", () => {
    expect(
      detectPromoEngineEmbedStatus(
        settings({
          embed: {
            type: "shopify://apps/promo-engine/blocks/app_embed/extension-id",
            disabled: false,
          },
        }),
      ),
    ).toBe("enabled");
  });

  it("treats a disabled app embed as disabled", () => {
    expect(
      detectPromoEngineEmbedStatus(
        settings({
          embed: {
            type: "shopify://apps/promo-engine-hpn/blocks/app_embed/extension-id",
            disabled: true,
          },
        }),
      ),
    ).toBe("disabled");
  });

  it("does not confuse another app embed with Promo Engine", () => {
    expect(
      detectPromoEngineEmbedStatus(
        settings({
          embed: {
            type: "shopify://apps/another-app/blocks/app_embed/extension-id",
            disabled: false,
          },
        }),
      ),
    ).toBe("disabled");
  });

  it("supports Shopify's leading theme-file comments", () => {
    const content = `/* Shopify generated file. */\n// Keep this file managed by Shopify.\n${settings({
      embed: {
        type: "shopify://apps/promo-engine/blocks/app_embed/extension-id",
      },
    })}`;

    expect(detectPromoEngineEmbedStatus(content)).toBe("enabled");
  });

  it("rejects malformed settings instead of reporting a false status", () => {
    expect(() => detectPromoEngineEmbedStatus("/* unterminated")).toThrow(SyntaxError);
    expect(() => detectPromoEngineEmbedStatus("{not-json}")).toThrow(SyntaxError);
  });
});
