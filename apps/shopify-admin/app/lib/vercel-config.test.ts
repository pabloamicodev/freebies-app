import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Both Vercel projects (HPN and Ambrosia) build from this folder, so an alias here
// is applied to both and fails the other with "alias already in use". See docs/DEPLOY.md.
describe("vercel.json", () => {
  for (const file of ["../../../../vercel.json", "../../vercel.json"]) {
    it(`${file} sets no alias`, () => {
      const config = JSON.parse(readFileSync(resolve(__dirname, file), "utf8"));
      expect(config).not.toHaveProperty("alias");
    });
  }
});
