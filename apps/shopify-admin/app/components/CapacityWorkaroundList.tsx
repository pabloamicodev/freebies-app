import { useEffect, useId, useMemo, useState } from "react";
import { Link, useFetcher } from "react-router";
import { confirmSemanticChangeLabel, incidentDialogCopy as copy } from "../lib/capacity-workaround-copy.js";
import type { IncidentProposals, WorkaroundOption, WorkaroundProposal, WorkaroundResult } from "../lib/capacity-workarounds.js";

export interface LazyOptions {
  state: "idle" | "loading" | "error" | "ready";
  items: WorkaroundOption[];
}

interface ListProps {
  incident: IncidentProposals;
  /** Kind being applied right now for this incident; every Apply is disabled meanwhile. */
  busyKind: string | null;
  result: WorkaroundResult | null;
  lazyOptions?: LazyOptions;
  onLoadOptions: () => void;
  onApply: (proposal: WorkaroundProposal, selected: string[], confirm: boolean) => void;
  onUndo: (actionId: string) => void;
  onDismiss?: () => void;
  /** Proposals only: the save-time modal already explains the limit above. */
  compact?: boolean;
}

const textStyle = { fontSize: 14, color: "var(--text-sub)", margin: 0, lineHeight: 1.6 } as const;
const headStyle = { fontSize: 13, fontWeight: 600, margin: "0 0 4px", color: "var(--text)" } as const;

function Proposal({ proposal, incident, busyKind, lazyOptions, onLoadOptions, onApply }: Pick<ListProps, "incident" | "busyKind" | "lazyOptions" | "onLoadOptions" | "onApply"> & { proposal: WorkaroundProposal }) {
  const uid = useId();
  const options = proposal.options;
  const items = options?.lazy ? (lazyOptions?.items ?? []) : (options?.items ?? []);
  const itemKey = items.map((item) => `${item.id}:${item.checked}`).join("|");
  const [selected, setSelected] = useState<string[]>(() => items.filter((item) => item.checked).map((item) => item.id));
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => setSelected(items.filter((item) => item.checked).map((item) => item.id)), [itemKey]);

  const busy = busyKind !== null;
  const applying = busyKind === proposal.kind;
  const missing = options ? Math.max(0, options.minSelected - selected.length) : 0;
  const blocked = busy || (proposal.semanticChange && !confirmed) || missing > 0;
  const customerChange =
    proposal.kind === "deactivate_discounts" && selected.length > 0
      ? `These Shopify discounts stop applying in your store: ${items.filter((item) => selected.includes(item.id)).map((item) => item.label).join(", ")}.`
      : proposal.customerChange;

  return (
    <section aria-labelledby={`${uid}-title`} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      <h4 id={`${uid}-title`} style={{ ...headStyle, margin: 0 }}>{proposal.title}</h4>
      <p style={textStyle}>{proposal.summary}</p>
      {options && (
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={headStyle}>{options.label}</legend>
          {options.lazy && lazyOptions?.state !== "ready" ? (
            <div>
              <button type="button" className="b-btn b-btn-secondary b-btn-sm" onClick={onLoadOptions} disabled={lazyOptions?.state === "loading"} aria-busy={lazyOptions?.state === "loading"}>
                {lazyOptions?.state === "loading" ? "Loading your discounts…" : "Show my Shopify discounts"}
              </button>
              {lazyOptions?.state === "error" && <p role="alert" style={{ ...textStyle, color: "var(--red)" }}>{copy.loadFailed}</p>}
            </div>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
              {items.map((item) => (
                <li key={item.id}>
                  <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, minHeight: 24 }}>
                    <input
                      type="checkbox"
                      checked={selected.includes(item.id)}
                      onChange={(event) => setSelected((now) => (event.target.checked ? [...now, item.id] : now.filter((id) => id !== item.id)))}
                    />
                    {item.label}
                  </label>
                </li>
              ))}
            </ul>
          )}
          {missing > 0 && (options.lazy ? lazyOptions?.state === "ready" : true) && <p id={`${uid}-min`} style={{ ...textStyle, fontSize: 13 }}>{copy.selectAtLeast(options.minSelected)}</p>}
        </fieldset>
      )}
      <div>
        <h5 style={{ ...headStyle, fontSize: 12 }}>{copy.whatChanges}</h5>
        <p style={textStyle}>{customerChange}</p>
      </div>
      {proposal.note && <p style={{ ...textStyle, fontSize: 13 }}>{proposal.note}</p>}
      {proposal.semanticChange && (
        <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 14, minHeight: 24 }}>
          <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} style={{ marginTop: 3 }} />
          {confirmSemanticChangeLabel}
        </label>
      )}
      <div>
        <button
          type="button"
          className="b-btn b-btn-primary"
          disabled={blocked}
          aria-busy={applying}
          aria-describedby={missing > 0 ? `${uid}-min` : undefined}
          onClick={() => onApply(proposal, selected, confirmed)}
        >
          {applying ? copy.applying : copy.apply}
          <span className="visually-hidden"> {proposal.title} for {incident.title}</span>
        </button>
      </div>
    </section>
  );
}

/** One blocked group of offers: why Shopify blocked it, the fixes on offer and what happened when one was tried. */
export function CapacityWorkaroundList(props: ListProps) {
  const { incident, result, compact = false } = props;
  const uid = useId();
  const applied = result?.ok === true && result.code === "applied";
  return (
    <article aria-labelledby={`${uid}-title`} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <header>
        <h3 id={`${uid}-title`} style={compact ? { ...headStyle, margin: 0 } : { fontSize: 15, fontWeight: 700, margin: 0, color: "var(--text)" }}>{compact ? "Fix it here" : incident.title}</h3>
        {!compact && incident.occurrences > 1 && <p style={{ ...textStyle, fontSize: 12 }}>{copy.seenTimes(incident.occurrences)}</p>}
      </header>
      {!applied && (
        <>
          {!compact && <p style={textStyle}>{incident.limit}</p>}
          {!compact && <p style={textStyle}>{incident.body}</p>}
          {!compact && incident.offers.length > 0 && (
            <ul style={{ ...textStyle, paddingLeft: 20 }} aria-label="Offers involved">
              {incident.offers.map((offer) => (
                <li key={offer.id}>{offer.name}</li>
              ))}
            </ul>
          )}
          {incident.proposals.map((proposal) => (
            <Proposal key={proposal.kind} proposal={proposal} incident={incident} busyKind={props.busyKind} lazyOptions={props.lazyOptions} onLoadOptions={props.onLoadOptions} onApply={props.onApply} />
          ))}
          {incident.proposals.length === 0 && incident.guidance && <p style={textStyle}>{incident.guidance}</p>}
          {incident.proposals.length === 0 && !incident.guidance && !compact && <p style={textStyle}>{incident.fix}</p>}
        </>
      )}
      <div role="status" aria-live="polite">
        {result && result.ok && <p style={{ ...textStyle, color: "var(--green)" }}>{result.message}</p>}
      </div>
      {result && !result.ok && <p role="alert" style={{ ...textStyle, color: "var(--red)" }}>{result.message}</p>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {applied && result.actionId && (
          <button type="button" className="b-btn b-btn-secondary" disabled={props.busyKind !== null} onClick={() => props.onUndo(result.actionId!)}>
            {copy.undo}
            <span className="visually-hidden"> {incident.title}</span>
          </button>
        )}
        {!applied && !compact && incident.actions.map((action) =>
          action.href ? (
            <a key={action.label} className="b-btn b-btn-secondary" href={action.href} target="_top" rel="noreferrer">{action.label}</a>
          ) : (
            <Link key={action.label} className="b-btn b-btn-secondary" to={action.to ?? "/app/offers"}>{action.label}</Link>
          ),
        )}
        {!applied && props.onDismiss && (
          <button type="button" className="b-btn b-btn-secondary" onClick={props.onDismiss} disabled={props.busyKind !== null}>
            {copy.dismiss}
            <span className="visually-hidden"> {incident.title}</span>
          </button>
        )}
      </div>
    </article>
  );
}

interface LoaderResult {
  error?: true;
  incidents?: IncidentProposals[];
  candidates?: Array<{ id: string; title: string; type: string; appTitle: string | null }>;
}

interface PanelProps {
  /** One incident (the save-time modal) or every open one (the dialog). */
  incidentId?: string;
  onLoaded?: (count: number) => void;
}

/** Loads incidents from `/app/capacity-incidents` and runs Apply, Undo and Dismiss against it. */
export function IncidentWorkaroundsPanel({ incidentId, onLoaded }: PanelProps) {
  const loader = useFetcher<LoaderResult>();
  const discounts = useFetcher<LoaderResult>();
  const actor = useFetcher<WorkaroundResult>();
  const [known, setKnown] = useState<IncidentProposals[]>([]);
  const [results, setResults] = useState<Record<string, WorkaroundResult>>({});
  const [busy, setBusy] = useState<{ incidentId: string; kind: string } | null>(null);
  const [lazyFor, setLazyFor] = useState<string | null>(null);
  const [requested, setRequested] = useState(false);
  const url = incidentId ? `/app/capacity-incidents?incident=${incidentId}` : "/app/capacity-incidents";

  useEffect(() => {
    setRequested(true);
    loader.load(url);
  }, [url]);

  useEffect(() => {
    const incoming = loader.data?.incidents;
    if (!incoming) return;
    setKnown((now) => [...incoming, ...now.filter((card) => results[card.incidentId]?.code === "applied" && !incoming.some((next) => next.incidentId === card.incidentId))]);
    onLoaded?.(incoming.length);
  }, [loader.data]);

  useEffect(() => {
    if (actor.state !== "idle" || !actor.data || !busy) return;
    setResults((now) => ({ ...now, [busy.incidentId]: actor.data! }));
    setBusy(null);
    if (actor.data.code === "undone" || actor.data.code === "applied") loader.load(url);
  }, [actor.state, actor.data]);

  const lazy = useMemo<LazyOptions>(() => {
    if (discounts.state !== "idle") return { state: "loading", items: [] };
    if (!discounts.data?.candidates) return { state: lazyFor ? "error" : "idle", items: [] };
    return { state: "ready", items: discounts.data.candidates.map((candidate) => ({ id: candidate.id, label: candidate.appTitle ? `${candidate.title} (${candidate.appTitle})` : candidate.title, checked: false })) };
  }, [discounts.state, discounts.data, lazyFor]);

  const submit = (fields: Record<string, string>, forIncident: string, kind: string) => {
    setBusy({ incidentId: forIncident, kind });
    actor.submit(fields, { method: "post", action: "/app/capacity-incidents" });
  };

  if (known.length === 0 && !loader.data?.incidents) {
    return loader.data?.error || (loader.state === "idle" && requested) ? (
      <p role="alert" style={{ ...textStyle, color: "var(--red)" }}>{copy.loadFailed}</p>
    ) : (
      <p role="status" style={textStyle}>{copy.loading}</p>
    );
  }
  if (known.length === 0) return <p role="status" style={textStyle}>{copy.empty}</p>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {known.map((incident) => (
        <CapacityWorkaroundList
          key={incident.incidentId}
          incident={incident}
          compact={incidentId !== undefined}
          busyKind={busy ? busy.kind : null}
          result={results[incident.incidentId] ?? null}
          lazyOptions={lazyFor === incident.incidentId ? lazy : { state: "idle", items: [] }}
          onLoadOptions={() => {
            setLazyFor(incident.incidentId);
            discounts.load(`/app/capacity-incidents?incident=${incident.incidentId}&discounts=1`);
          }}
          onApply={(proposal, selected, confirm) =>
            submit(
              {
                intent: "apply",
                incidentId: incident.incidentId,
                kind: proposal.kind,
                selected: JSON.stringify(selected),
                confirm: String(confirm),
                expectedVersions: JSON.stringify(proposal.offerVersions),
              },
              incident.incidentId,
              proposal.kind,
            )
          }
          onUndo={(actionId) => submit({ intent: "undo", actionId }, incident.incidentId, "undo")}
          onDismiss={() => submit({ intent: "dismiss", incidentId: incident.incidentId }, incident.incidentId, "dismiss")}
        />
      ))}
    </div>
  );
}
