import { useEffect, useId, useState } from "react";
import { useFetcher } from "react-router";
import type { ThemeCatalog } from "../lib/theme-refs.js";
import {
  addManualSection,
  addManualTemplate,
  normalizeForSearch,
  sectionDisplayLabel,
  sectionRefOf,
  staleSectionRefs,
  staleTemplateRefs,
  STALE_SECTION_MESSAGE,
  STALE_TEMPLATE_MESSAGE,
  toggleSection,
  toggleTemplate,
  type SectionSelection,
} from "../lib/theme-target-selection.js";

export const THEME_CATALOG_PATH = "/app/api/theme-catalog";

/** `undefined` = still loading, `null` = failed to load; `{ unavailable: true }` = theme unreadable. */
export type CatalogState = ThemeCatalog | null | undefined;

type PickerSelection =
  | { kind: "template"; value: string[]; onChange: (next: string[]) => void }
  | { kind: "section"; value: SectionSelection[]; onChange: (next: SectionSelection[]) => void };

type ViewProps = PickerSelection & { idPrefix: string; catalog: CatalogState };

const tag = { fontSize: 11, color: "var(--text-sub)", marginLeft: 6 } as const;

/** Presentational half: everything the merchant sees, no data fetching (testable without a router). */
export function ThemeTargetPickerView(props: ViewProps) {
  const { kind, idPrefix, catalog } = props;
  const [query, setQuery] = useState("");
  const [manual, setManual] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);
  const live = catalog && !catalog.unavailable ? catalog : null;
  const unavailable = catalog === null || catalog?.unavailable === true;
  const q = normalizeForSearch(query);

  const stale =
    props.kind === "template"
      ? staleTemplateRefs(props.value, live)
      : staleSectionRefs(props.value, live);

  function addManual() {
    const result =
      props.kind === "template"
        ? addManualTemplate(props.value, manual)
        : addManualSection(props.value, manual, catalog ?? null);
    if (!result.ok) {
      setManualError(result.error);
      return;
    }
    setManualError(null);
    setManual("");
    if (props.kind === "template") props.onChange(result.value as string[]);
    else props.onChange(result.value as SectionSelection[]);
  }

  const selectedRows =
    props.kind === "template"
      ? props.value.map((ref) => ({
          ref,
          label: ref,
          remove: () => props.onChange(props.value.filter((r) => r !== ref)),
        }))
      : props.value.map((section) => ({
          ref: sectionRefOf(section),
          label: sectionDisplayLabel(section, live),
          remove: () => props.onChange(props.value.filter((s) => sectionRefOf(s) !== sectionRefOf(section))),
        }));

  const options =
    props.kind === "template"
      ? (live?.templates ?? [])
          .filter((t) => !q || normalizeForSearch(`${t.ref} ${t.pageType}`).includes(q))
          .map((t) => ({
            ref: t.ref,
            primary: t.ref,
            secondary: t.pageType,
            checked: props.value.includes(t.ref),
            toggle: () => props.onChange(toggleTemplate(props.value, t.ref)),
          }))
      : (live?.sections ?? [])
          .filter((s) => !q || normalizeForSearch(`${s.label} ${s.key} ${s.template}`).includes(q))
          .map((s) => ({
            ref: s.ref,
            primary: s.disabled ? `${s.label} (disabled)` : s.label,
            secondary: s.key,
            checked: props.value.some((v) => sectionRefOf(v) === s.ref),
            toggle: () =>
              props.onChange(toggleSection(props.value, { template: s.template, key: s.key, label: s.label })),
          }));

  const noun = kind === "template" ? "templates" : "sections";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {selectedRows.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          {selectedRows.map((row) => {
            const isStale = stale.includes(row.ref);
            return (
              <li key={row.ref} className="b-checkbox-row" style={{ justifyContent: "space-between", gap: 8 }}>
                <span style={{ fontSize: 13 }}>
                  {row.label}
                  {kind === "section" && <span style={tag}>{row.ref.split("/").pop()}</span>}
                  {isStale && <span style={{ ...tag, color: "var(--orange, #b45309)" }}>not in theme</span>}
                </span>
                <button type="button" className="b-btn-plain b-text-sm" onClick={row.remove} aria-label={`Remove ${row.label}`}>
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {stale.length > 0 && (
        <div className="b-banner b-banner-orange" role="status">
          <div className="b-banner-body">
            <p className="b-banner-text">{kind === "section" ? STALE_SECTION_MESSAGE : STALE_TEMPLATE_MESSAGE}</p>
          </div>
        </div>
      )}

      {catalog === undefined && <div className="b-help">Loading your published theme…</div>}
      {unavailable && (
        <div className="b-help">
          Your theme could not be read, so type the {kind === "section" ? "section as template/section-key" : "template name"} below.
        </div>
      )}

      {live && (
        <div>
          <label className="b-label" htmlFor={`${idPrefix}-search`}>
            Search {noun} in {live.themeName}
          </label>
          <input
            id={`${idPrefix}-search`}
            className="b-input"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoComplete="off"
          />
          <div
            role="group"
            aria-label={`Available ${noun}`}
            style={{ maxHeight: 220, overflowY: "auto", marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}
          >
            {options.length === 0 && <div className="b-help">No {noun} match.</div>}
            {options.map((option) => {
              const id = `${idPrefix}-opt-${option.ref}`;
              return (
                <label key={option.ref} htmlFor={id} className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                  <input
                    id={id}
                    type="checkbox"
                    checked={option.checked}
                    onChange={option.toggle}
                    style={{ accentColor: "var(--blue)", width: 14, height: 14 }}
                  />
                  <span style={{ fontSize: 13 }}>
                    {option.primary}
                    <span style={tag}>{option.secondary}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      )}

      <div>
        <label className="b-label" htmlFor={`${idPrefix}-manual`}>
          {kind === "section" ? "Add a section by ID" : "Add a template by name"}
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            id={`${idPrefix}-manual`}
            className="b-input"
            value={manual}
            onChange={(event) => setManual(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addManual();
              }
            }}
            placeholder={kind === "section" ? "page.landing/hero_abc or shopify-section-template--123__hero_abc" : "page.landing"}
            autoComplete="off"
            aria-invalid={manualError ? true : undefined}
            aria-describedby={manualError ? `${idPrefix}-manual-error` : undefined}
          />
          <button type="button" className="b-btn b-btn-secondary b-btn-sm" onClick={addManual}>
            Add
          </button>
        </div>
        {manualError && (
          <div id={`${idPrefix}-manual-error`} className="b-help" role="alert" style={{ color: "var(--red, #b91c1c)" }}>
            {manualError}
          </div>
        )}
      </div>
    </div>
  );
}

/** Loads the published-theme catalog once and renders the picker. */
export function ThemeTargetPicker(props: PickerSelection & { idPrefix?: string }) {
  const generated = useId();
  const fetcher = useFetcher<ThemeCatalog>();
  const [requested, setRequested] = useState(false);
  useEffect(() => {
    if (requested) return;
    setRequested(true);
    void fetcher.load(THEME_CATALOG_PATH);
  }, [requested, fetcher]);
  // A finished load with no data means the request failed: fall back to manual entry.
  const failed = requested && fetcher.state === "idle" && fetcher.data === undefined;
  const catalog: CatalogState = failed ? null : fetcher.data;
  return <ThemeTargetPickerView {...props} idPrefix={props.idPrefix ?? generated} catalog={catalog} />;
}
