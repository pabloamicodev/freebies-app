import { describe, expect, it } from "vitest";
import { escapeHtml } from "../html.js";

describe("volume discount escaping", () => {
  it("escapes merchant-controlled tier labels for text and attributes", () => {
    expect(escapeHtml('<img src=x onerror="alert(1)"> & deal'))
      .toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; deal");
  });
});
