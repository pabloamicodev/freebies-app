import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExperimentPickerView, type DirectoryState } from "../components/ExperimentPicker.js";
import { STALE_ARM_MESSAGE, STALE_EXPERIMENT_MESSAGE } from "./experiment-directory.js";

const directory: DirectoryState = {
  experiments: [
    {
      id: "abcd1234",
      name: "PDP hero v2",
      status: "RUNNING",
      mode: "inline",
      variants: [
        { key: "control", name: "Control", control: true },
        { key: "variant_a", name: "Variant A", control: false },
      ],
    },
  ],
};
const noop = () => undefined;
const render = (state: DirectoryState, experimentId = "", variantKeys: string[] = [], experimentName = "") =>
  renderToStaticMarkup(
    createElement(ExperimentPickerView, { idPrefix: "t", directory: state, experimentId, experimentName, variantKeys, onChange: noop }),
  );

describe("ExperimentPicker", () => {
  it("lists experiments with status and mode", () => {
    expect(render(directory)).toContain("PDP hero v2 · running · Seamless swap");
  });

  it("shows the arms of the selected experiment as checkboxes", () => {
    const html = render(directory, "abcd1234", ["variant_a"]);
    expect(html).toContain("Variant A");
    expect(html).toContain("control");
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html).not.toContain(STALE_EXPERIMENT_MESSAGE);
  });

  it("falls back to manual entry when the directory is unavailable or failed to load", () => {
    for (const state of [{ unavailable: true } as DirectoryState, null]) {
      expect(render(state)).toContain("not detected");
    }
    expect(render(undefined)).toContain("Loading");
  });

  it("warns when the stored experiment is gone", () => {
    const html = render(directory, "deadbeef", ["control"], "Old test").replace(/&#x27;/g, "'");
    expect(html).toContain(STALE_EXPERIMENT_MESSAGE);
    expect(html).toContain("Old test (not in directory)");
  });

  it("warns when a stored arm is gone", () => {
    expect(render(directory, "abcd1234", ["control", "variant_z"])).toContain(STALE_ARM_MESSAGE);
  });
});
