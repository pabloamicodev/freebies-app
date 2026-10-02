import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const EMBED = resolve(__dirname, "../../../apps/shopify-admin/extensions/theme-extension/blocks/app_embed.liquid");

/** Output tags whose quoted strings contain "{{" / "}}" (Liquid ends the tag at the first "}}", truncating the string). */
function brokenOutputTags(liquid: string): string[] {
  const source = liquid.replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, "");
  const bad: string[] = [];
  for (const m of source.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    const body = m[1] ?? "";
    const quotesBalanced = (body.match(/"/g)?.length ?? 0) % 2 === 0 && (body.match(/'/g)?.length ?? 0) % 2 === 0;
    if (body.includes("{{") || !quotesBalanced) bad.push(m[0]);
  }
  const withoutTags = source.replace(/\{\{[\s\S]*?\}\}/g, "");
  if (/\{\{|\}\}/.test(withoutTags)) bad.push("stray {{ or }} outside a tag");
  return bad;
}

describe("app_embed.liquid", () => {
  it("never puts {{ or }} inside a quoted string of an output tag (use __name__ placeholders)", () => {
    expect(brokenOutputTags(readFileSync(EMBED, "utf8"))).toEqual([]);
  });

  it("the guard catches the regression it exists for", () => {
    expect(brokenOutputTags(`{{ 'k' | t: percent: '{{percent}}' | json }}`).length).toBeGreaterThan(0);
    expect(brokenOutputTags(`{{ 'k' | t: percent: '__percent__' | json }}`)).toEqual([]);
  });
});
