import { useEffect, useId, useState } from "react";
import { useFetcher } from "react-router";
import {
  experimentStaleness,
  MODE_LABELS,
  STALE_ARM_MESSAGE,
  STALE_EXPERIMENT_MESSAGE,
  type ExperimentDirectory,
} from "../lib/experiment-directory.js";

export const EXPERIMENTS_PATH = "/app/api/experiments";

/** `undefined` = still loading, `null` = failed to load; `{ unavailable: true }` = not detected. */
export type DirectoryState = ExperimentDirectory | null | undefined;

export interface ExperimentSelection {
  experimentId: string;
  experimentName: string;
  variantKeys: string[];
}

interface ViewProps extends ExperimentSelection {
  idPrefix: string;
  directory: DirectoryState;
  onChange: (next: ExperimentSelection) => void;
}

const tag = { fontSize: 11, color: "var(--text-sub)", marginLeft: 6 } as const;

/** Presentational half: everything the merchant sees, no data fetching (testable without a router). */
export function ExperimentPickerView({ idPrefix, directory, experimentId, experimentName, variantKeys, onChange }: ViewProps) {
  const live = directory && !directory.unavailable ? directory : null;
  const experiment = live?.experiments.find((e) => e.id === experimentId);
  const stale = experimentStaleness(experimentId, variantKeys, live);

  if (directory === undefined) return <div className="b-help">Loading your experiments…</div>;
  if (!live) {
    return <div className="b-help">Experiment Engine was not detected on this store, so enter the experiment below.</div>;
  }

  const toggleArm = (key: string) =>
    onChange({
      experimentId,
      experimentName,
      variantKeys: variantKeys.includes(key) ? variantKeys.filter((k) => k !== key) : [...variantKeys, key],
    });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {stale && (stale.experimentMissing || stale.missingArms.length > 0) && (
        <div className="b-banner b-banner-orange" role="status">
          <div className="b-banner-body">
            <p className="b-banner-text">
              {stale.experimentMissing ? STALE_EXPERIMENT_MESSAGE : `${STALE_ARM_MESSAGE} (${stale.missingArms.join(", ")})`}
            </p>
          </div>
        </div>
      )}
      <div>
        <label className="b-label" htmlFor={`${idPrefix}-experiment-select`}>Experiment</label>
        <select
          id={`${idPrefix}-experiment-select`}
          className="b-select"
          value={experiment ? experiment.id : ""}
          onChange={(event) => {
            const next = live.experiments.find((e) => e.id === event.target.value);
            if (next) onChange({ experimentId: next.id, experimentName: next.name, variantKeys: [] });
          }}
        >
          <option value="">{experimentId && !experiment ? `${experimentName || experimentId} (not in directory)` : "— Select —"}</option>
          {live.experiments.map((e) => (
            <option key={e.id} value={e.id}>
              {[e.name, e.status.toLowerCase(), MODE_LABELS[e.mode]].filter(Boolean).join(" · ")}
            </option>
          ))}
        </select>
      </div>
      {experiment && (
        <div role="group" aria-label="Experiment arms" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {experiment.variants.map((v) => {
            const id = `${idPrefix}-arm-${v.key}`;
            return (
              <label key={v.key} htmlFor={id} className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                <input
                  id={id}
                  type="checkbox"
                  checked={variantKeys.includes(v.key)}
                  onChange={() => toggleArm(v.key)}
                  style={{ accentColor: "var(--blue)", width: 14, height: 14 }}
                />
                <span style={{ fontSize: 13 }}>
                  {v.name}
                  <span style={tag}>{v.key}{v.control ? " · control" : ""}</span>
                </span>
              </label>
            );
          })}
          <div className="b-help">Matches visitors in any of the selected arms.</div>
          {experiment.status === "DRAFT" && <div className="b-help">This experiment is still a draft: arm keys can change until it launches.</div>}
          {experiment.status === "COMPLETED" && <div className="b-help">This experiment has completed.</div>}
        </div>
      )}
    </div>
  );
}

/** Loads the shop's experiment directory once and renders the picker. */
export function ExperimentPicker(props: ExperimentSelection & { onChange: ViewProps["onChange"]; idPrefix?: string }) {
  const generated = useId();
  const fetcher = useFetcher<ExperimentDirectory>();
  const [requested, setRequested] = useState(false);
  useEffect(() => {
    if (requested) return;
    setRequested(true);
    void fetcher.load(EXPERIMENTS_PATH);
  }, [requested, fetcher]);
  // A finished load with no data means the request failed: fall back to manual entry.
  const failed = requested && fetcher.state === "idle" && fetcher.data === undefined;
  return <ExperimentPickerView {...props} idPrefix={props.idPrefix ?? generated} directory={failed ? null : fetcher.data} />;
}
