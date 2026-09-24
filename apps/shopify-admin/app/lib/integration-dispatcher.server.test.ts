import { describe, expect, it } from "vitest";
import {
  classifyIntegrationFailures,
  PermanentIntegrationError,
  TransientIntegrationError,
} from "./integration-dispatcher.server.js";

describe("classifyIntegrationFailures", () => {
  it("returns null when every destination succeeds", () => {
    expect(classifyIntegrationFailures([])).toBeNull();
  });

  it("prioritizes a transient failure so the source webhook is retried", () => {
    const permanent = new PermanentIntegrationError("bad credentials");
    const transient = new TransientIntegrationError("rate limited");
    expect(classifyIntegrationFailures([permanent, transient])).toBe(transient);
  });

  it("preserves a permanent destination rejection", () => {
    const permanent = new PermanentIntegrationError("rejected");
    expect(classifyIntegrationFailures([permanent])).toBe(permanent);
  });

  it("treats unknown failures as retryable instead of losing the event", () => {
    expect(classifyIntegrationFailures([new Error("unexpected")])).toBeInstanceOf(TransientIntegrationError);
  });
});
