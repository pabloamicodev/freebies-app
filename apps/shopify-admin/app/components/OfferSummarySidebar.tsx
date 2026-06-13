/**
 * Shared sticky sidebar for all offer creation wizards.
 * Shows a live summary checklist and a help card.
 */

import { IconLink, IconClock, IconCondition, IconCheck } from "./Icons.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SummaryStepItem {
  icon?: () => JSX.Element;
  text?: string;
  lines?: string[];
}

export interface SummaryStep {
  label: string;
  checked: boolean;
  optional?: boolean;
  items?: SummaryStepItem[];
  emptyText?: string;
}

export interface OfferSummarySidebarProps {
  title?: string;
  startDate?: string;
  steps: SummaryStep[];
  aboveSummary?: React.ReactNode;
  belowSummary?: React.ReactNode;
  helpCard?: React.ReactNode | null;
  accentColor?: string;
}

// ─── Step dot ────────────────────────────────────────────────────────────────

function StepDot({ checked, index, accentColor }: { checked: boolean; index: number; accentColor: string }) {
  return (
    <div className="rd-style-014" style={{ background: checked ? accentColor : "var(--bg-card, #fff)", border: `2px solid ${checked ? "transparent" : "var(--border, #e1e3e5)"}`, boxShadow: checked ? `0 2px 6px ${accentColor}55` : "0 1px 2px rgba(0,0,0,0.06)" }}>
      {checked
        ? <IconCheck />
        : <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted, #9ca3af)", lineHeight: 1 }}>{index + 1}</span>
      }
    </div>
  );
}

function ItemIcon({ icon }: { icon?: () => JSX.Element }) {
  const Icon = icon ?? IconCondition;
  return <span style={{ color: "var(--text-muted)", flexShrink: 0, marginTop: 1, opacity: 0.7 }}><Icon /></span>;
}

function summaryItemKey(item: SummaryStepItem): string {
  return item.text ?? item.lines?.join("|") ?? item.icon?.name ?? "summary-item";
}

// ─── Help card ───────────────────────────────────────────────────────────────

function DefaultHelpCard() {
  return (
    <div style={{
      background: "linear-gradient(145deg, #1e1b4b 0%, #312e81 50%, #3730a3 100%)",
      border: "none", borderRadius: 12, overflow: "hidden",
      boxShadow: "0 4px 16px rgba(49,46,129,0.3), 0 1px 4px rgba(0,0,0,0.1)",
    }}>
      <div style={{ padding: "16px 18px" }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
          <div className="rd-style-015">
            <svg width="18" height="18" viewBox="0 0 20 20" fill="white">
              <path fillRule="evenodd" d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0ZM8.94 6.94a.75.75 0 1 1-1.061-1.061 3 3 0 1 1 2.871 5.026v.345a.75.75 0 0 1-1.5 0v-.5c0-.72.57-1.172 1.081-1.287A1.5 1.5 0 1 0 8.94 6.94ZM10 15a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clipRule="evenodd"/>
            </svg>
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#fff", marginBottom: 2, letterSpacing: "-0.1px" }}>
              Need help?
            </div>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.6)" }}>
              Our team is ready to assist
            </div>
          </div>
        </div>
        <button
          type="button"
          className="rd-style-016"
          onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.2)")}
          onMouseLeave={e => (e.currentTarget.style.background = "rgba(255,255,255,0.12)")}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
          Chat with us
        </button>
      </div>
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export function OfferSummarySidebar({
  title,
  startDate,
  steps,
  aboveSummary,
  belowSummary,
  helpCard,
  accentColor = "#059669",
}: OfferSummarySidebarProps) {
  const enrichedSteps = steps.map((step, i) => {
    if (i === 0 && (title || startDate)) {
      if (step.items && step.items.length > 0) return step;
      const extraItems: SummaryStepItem[] = [];
      if (title) extraItems.push({ icon: IconLink, text: title });
      if (startDate) extraItems.push({ icon: IconClock, text: `Starts ${startDate}` });
      return { ...step, items: extraItems.length > 0 ? extraItems : step.items };
    }
    return step;
  });

  const completedCount = enrichedSteps.filter((s) => s.checked).length;
  const totalRequired = enrichedSteps.filter((s) => !s.optional).length;
  const isComplete = completedCount >= totalRequired;
  const progress = totalRequired > 0 ? Math.round((completedCount / totalRequired) * 100) : 0;

  return (
    <div style={{ position: "sticky", top: 20, display: "flex", flexDirection: "column", gap: 14 }}>
      {helpCard !== null && (helpCard ?? <DefaultHelpCard />)}

      {aboveSummary}

      {/* Summary card */}
      <div style={{
        background: "var(--bg-card)", border: "1px solid var(--border)",
        borderRadius: 12, overflow: "hidden",
        boxShadow: "0 2px 4px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)",
      }}>
        {/* Header */}
        <div style={{
          padding: "13px 18px 12px",
          borderBottom: "1px solid var(--border-light)",
          background: "var(--bg-hover)",
          display: "flex", alignItems: "center", justifyContent: "space-between",
        }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", letterSpacing: "0.4px", textTransform: "uppercase" }}>
            Setup checklist
          </span>
          <span className="rd-style-017" style={{ background: isComplete ? "var(--green-badge)" : "var(--border-light)", color: isComplete ? "var(--green-txt)" : "var(--text-sub)", border: isComplete ? "1px solid #a7f3d0" : "1px solid var(--border)" }}>
            {completedCount}/{totalRequired}
          </span>
        </div>

        {/* Progress bar */}
        <div style={{ height: 3, background: "var(--border-light)" }}>
          <div
            className="b-summary-progress-fill"
            style={{ background: accentColor, transform: `scaleX(${progress / 100})` }}
          />
        </div>

        {/* Steps */}
        <div style={{ position: "relative", padding: "18px 18px 20px" }}>
          {/* Timeline connector */}
          <div style={{
            position: "absolute",
            left: 30,
            top: 30,
            bottom: 20,
            width: 1,
            background: "linear-gradient(to bottom, var(--border) 60%, transparent 100%)",
          }} />

          {enrichedSteps.map((step, i) => (
            <div
              key={step.label}
              style={{
                display: "flex", gap: 12, alignItems: "flex-start",
                marginBottom: i < enrichedSteps.length - 1 ? 20 : 0,
              }}
            >
              <StepDot checked={step.checked} index={i} accentColor={accentColor} />
              <div style={{ flex: 1, paddingTop: 3, minWidth: 0 }}>
                <div style={{
                  fontSize: 13, fontWeight: step.checked ? 600 : 500,
                  color: step.checked ? "var(--text)" : "var(--text-sub)",
                  display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap",
                }}>
                  {step.label}
                  {step.optional && !step.checked && (
                    <span style={{
                      fontSize: 12, fontWeight: 500, color: "var(--text-muted)",
                      background: "var(--border-light)", padding: "1px 6px",
                      borderRadius: 100, border: "1px solid var(--border)",
                    }}>
                      optional
                    </span>
                  )}
                </div>

                {step.checked && step.items && step.items.length > 0 ? (
                  <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                    {step.items.map((item) => (
                      <div key={summaryItemKey(item)} style={{ display: "flex", gap: 5, alignItems: "flex-start" }}>
                        <ItemIcon icon={item.icon} />
                        {item.text ? (
                          <span style={{
                            fontSize: 12, color: "var(--text-sub)", lineHeight: 1.5,
                            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                          }}>{item.text}</span>
                        ) : item.lines ? (
                          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                            {item.lines.map((l) => (
                              <span key={l} style={{ fontSize: 12, color: "var(--text-sub)", lineHeight: 1.5 }}>{l}</span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : !step.checked ? (
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3, fontStyle: "italic" }}>
                    {step.emptyText ?? "Not configured yet"}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </div>

      {belowSummary}
    </div>
  );
}
