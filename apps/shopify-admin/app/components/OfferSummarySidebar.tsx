/**
 * Shared sidebar component for all offer creation templates.
 * Renders a help card + summary timeline matching BOGOS.io design.
 *
 * Each template customises the steps array and optionally the right-column content.
 */

import { IconLink, IconClock, IconCondition,  IconCheck } from "./Icons.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SummaryStepItem {
  /** Icon component (12px muted) rendered before the text. Defaults to IconCondition. */
  icon?: () => JSX.Element;
  /** Single-line text. Use this OR lines (not both). */
  text?: string;
  /** Multi-line text array. Use this OR text (not both). */
  lines?: string[];
}

export interface SummaryStep {
  /** Step title shown next to the bullet. */
  label: string;
  /** Whether the step is completed (green check) or empty (gray circle). */
  checked: boolean;
  /** Shows "(opcional)" after the label when incomplete. */
  optional?: boolean;
  /** Items shown indented below the label. Each renders with its own mini icon. */
  items?: SummaryStepItem[];
  /** Text shown dimmed when the step is empty/incomplete. */
  emptyText?: string;
}

export interface OfferSummarySidebarProps {
  /** Title shown in the summary header line (e.g. the offer's public title). */
  title?: string;
  /** Formatted start date string. */
  startDate?: string;
  /** Steps to render in the timeline. */
  steps: SummaryStep[];
  /** Optional extra content above the summary card (e.g. FBT preview panel). */
  aboveSummary?: React.ReactNode;
  /** Optional content below the summary card. */
  belowSummary?: React.ReactNode;
  /** Override the help card entirely (pass null to hide, or a custom element). */
  helpCard?: React.ReactNode | null;
}

// ─── Internal helpers ───────────────────────────────────────────────────────

function Dot({ checked }: { checked: boolean }) {
  return (
    <div
      style={{
        width: 21,
        height: 21,
        borderRadius: "50%",
        flexShrink: 0,
        zIndex: 1,
        background: checked ? "var(--green-badge, #d1fae5)" : "var(--bg-card, #fff)",
        border: `2px solid ${checked ? "var(--green, #008060)" : "var(--border, #e5e7eb)"}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {checked && <IconCheck />}
    </div>
  );
}

function StepIcon({ icon }: { icon?: () => JSX.Element }) {
  const Icon = icon ?? IconCondition;
  return (
    <span style={{ color: "var(--text-sub, #6d7175)", flexShrink: 0, marginTop: 1 }}>
      <Icon />
    </span>
  );
}

// ─── Default help card ──────────────────────────────────────────────────────

function DefaultHelpCard() {
  return (
    <div className="b-card">
      <div className="b-card-body" style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <div style={{ width: 60, height: 60, borderRadius: 8, overflow: "hidden", flexShrink: 0 }}>
          <img
            loading="lazy"
            src="data:image/webp;base64,UklGRuoJAABXRUJQVlA4WAoAAAAQAAAAPwAAPwAAQUxQSMEFAAABmV2I6H8sZwIiIlyOtu2m9TzrX+u3bdu2UfoPK06AI8gM0mUCts3OTirbtvMFa6tLGTEBDAMgbUP2agG9gtK1bYck6XkjIp1Ztm10j23btm3PLM0fYNs2d22Wbdt8z6l4vy+iajXLiGDgtpGiLB92t3PwBuK/tcSJFC2SFg5MC4srU7OTG028VIkMAUUoghC0j1seG5rYOIxsWTRFwG4MewR/ChY6BzaIXPlCCX98QqXzHX0bQKQqiQDlF8Ufp3D5/I659VKgWCgAwnABE5iUKzGFjmhpd02CxQYMCOxJ67d/BsqbGt1e95gCQGDk3T/41GBp1053/G3HffSRIhTbLAE43AJIWcDgwUlJTz88k3vQdjcsUAArbFYNEBZLx5ELBbVz0UVJZ3+B/Ir9LlgMd6zXzKYqHO+dI4iJVkUQflNXWm4C1TvqnWmAIxoZdp4CcGYrYC0Y8Eg9XSi1FWz6YdpFN1UkDxrWsfAmNw+YAILH/OSCEIaFUZ1SfHLRbmJEpyj3nXAEIMhJHCDkZVTuc4GmAFisDBCly3JIBuSa7bqVIEi1QECAkMeHfLDgiBIKQL8y+OyKEkmSATe8UiJJqTH7QPVSrqIJeMRcQpu2uKgAtMMrq7yERWrgjHWQZLlIbTSHWiZWB6Y090DoyfNvWxHIhlveMnDePDjHwDu7FBOa1wlI2QyEsjq11PkHoeCLCEkM4CvA0BRcBBjWHx0PYRJSf9BSyXomlAs6FZnlAmQAtBiZvnjM4sek2c5kDyA9KIWOQtEc22e8kaDRIpbAGhNwxw5vQGEl+oQCWUkfw7ltGrIYgGIAQnMy0TSgwHyrveWcAkxq3CmxkKp9IRiOvO2TANdd9UWaYQjxwDq1aiTocJii9KAMAUuZA6XriGFYShVRCu/sBJEHMD56ZL+5ctQKI1hzGCsXUnVkaJ857d9CEYiABwyhaEAUDXgP4TRB7OK5UaSEtcCxeCdOsUTvoBpQZS/EyoYXXOLgy01P9/lERKlSknQYTlzTItyUR2JlAYrM90iBcLjGcMwqK31SAHBtw3bFCh2v0U3YuRMAzhRuTstF6ftRseXMCLDYN73ozQ4jctCVP04RoD/0bVyH3bttY1GRH7fYXItNWd7p5l0EgCnuNC9Gt/aDQZs2YTocueCXEQJDx6sJV2PvHpImESAFKCpCa6V+G1kMkAF8XV3lPe3HaegNfS77cuxX30RKXKySIu0UL3Y2WEzqaTU7D/Ce8vOSfvOdx1yC2hqAQWBDqGUiFmtbGkJNiygsKgstjUWhshr94Kwbzkd9HUO1Q1Fpb+c8zDaqBbQG0/4Towv9K9pc8cw5aKzXHAZNAWUEYe9VRJo2oJojPBld+uGnl6C91vEVxUpIL/WZUPECJoDxZSvR0vPQE7Gj2xWYHH6fMGXpBCVjWqgYTYp3oPrrXLS2O/SYwGQzqyMngC7BAjwO4Ndj/JgfWWbQ+AQYgSRo1iqcBynCCsdgfmgNplVYTtxwR7lfKujqBHwVfu0PSY5Ow0KN7QGxAZgOhL+OJKYEbbp72Vfqg7s0Ndm/LFoRvw724PIHAWI+CL19nmIf+nrFfqbshJXdTBo/LAgIcBoAbxxkO7UJ/WP5Xgz0q1bNwYyZliZqYhFsAiY5kfZ5FDEqMBbyYnAQEsL0ipneDEiIIT003FS45nEAJQAwPAwVxni8P31AVaHR4wrcfQ+QZwBjI3o1E8tWbMK480faHXjpQkTHYXyMmACNVf1pRsKaFok8gdyCVy5hA6vEsGH1uKFEIyZzclajA2KzCVfpwQeFOw4+0epInGnFrS4vMoQkBnxuK+CWh6PZYAcpxDQa8huGN6xXs+oWZH2XxQRoNwPA/ITPMk0tK7OuAa54IktsUTMLG1cWhAJoPDUJ7tOVT2ZD7pcjEBQJ6kraNdaVjrn6nFg5R51ayLtodPyHdaZjNx0bnZPrODvtJP65Gf8LEwAAVlA4IAIEAABwFACdASpAAEAAPpFEnUslo6KhpAm4sBIJbACyUiBgHiLwyNun4nP7Ae7N6EPNm/wHW3+gx0qf25e0rmDWoq+vj7P9B7Gf0DvnlBGPbVrMx8hOoT+sPVk9Fz9jk+sINjQK0rZBawQLlnfvxEY9DIC292fA28d6+nXyWIywOIyk8cAqSt0+CL6FyI4KN0jSerqB5Kun3PKcADQFZRcMXcrmaKMC4Y5UN9Ax1S7CAP70dL5o7LzaFSBPCOZxEbAAOtjys7rL0T4pkSJySOEETuKGbYw/9Rex6qrDuC6LRrE/5GfeS8fr7Gfwq0mgf+bVcTQTuY41upOC3ZiiFV3Sj94kV7f9nti++BQ8odzYW1QvL4UbvYfX/k+qE2kXOAcS7+BXJYLvP/VlZzYN1AXMJUTUiU6qR0LTIprS/5RPfeOJ4o4cf1jQ//knGdejiWbL2f+2kQtAyfubG5vuoVqc1E7knGVdago/jxemLf0ylqNU0E88F2+mr7Cp1LPv+khAHgdwH4cD33tzcxUYHTVK0iKpP38MMuhlTjilbGv9DrDkdODcHWxkVDeZr4them1IF+ifbORU6WYBuKXgM0N72RjPEiGSFnF7z96zMGwOarnfnj0MG9+qDj4KeE4Hp9D9w5R015GZGIYZ+UmJ5cU2KQpfRz0W1FbgnATRRC4AhVNF7VAOz03deiQGryy7ZppfWJRVNY6jJzxU8XEnIlDqCS9J1l7zqQ8b7ymi85dk3haUNr1Zjjh72ssDCxEA3YNi52tomhKWCXWT0ZIq9WFCXd0EBMk7VFH4XJnfeejFl5Faf2qQGDXrSZG4h30Zgv7uFtjvsFVqPDIDe9dwxF+dvcFLjcUOdV8Bw0qnrXzNR43agyr9fx1C45ebM0aN1mii7Q+vCFE6rAN3vrPNDhwrrobxTJLd1n5i+cZPU3r283HRRikgN+k5RC+EpHo43CtzfXIYke7W9YpSNgaIky55zeAfivyhs8M977sLZY/XhABzHK4dkd6rJX+80EyKzxMRRHKHnx/mSJXM1oWb2KEt38eZWNE2WkjUOCMDkI7oLKvzbm4frOVoZg1OfgDn+j7f2+/sImJxNxwzxQqzD0HTZiZnWB5rHlCb283wgA+67dOpPbu57xqgUOjeOnOorkFP7y6BPzHhSy7/8j3yazsPHxen0qMZ/5Fcx/qYz9GKL6wPkWJWkl6FgfExSEJ0WQ5ghu10wblMXoadVVcQ4Y+lnkFwqWQwGREBompTEUY/t0i4KY2a+KE/HSvE0dfoSBPDzm98tT3Krfi5+Gg0hMwengz/sZ6rVNPLa7IvEqiL6nADFPOUUSHYbNxqUSqggfHTmft5u2VVMhW/AKf/V3MS2bPPgAA="
            alt="help"
            style={{ width: 60, height: 60, objectFit: "cover" }}
          />
        </div>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>
            ¿Necesitas ayuda para crear ofertas?
          </div>
          <div style={{ fontSize: 12, color: "var(--text-sub)", marginBottom: 10 }}>
            Chatea con nosotros para obtener ayuda
          </div>
          <button type="button" className="b-btn b-btn-secondary b-btn-sm">
            Chatea con nosotros
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Component ──────────────────────────────────────────────────────────────

export function OfferSummarySidebar({
  title,
  startDate,
  steps,
  aboveSummary,
  belowSummary,
  helpCard,
}: OfferSummarySidebarProps) {
  // Inject title/startDate into the first "Información básica" step if not already there
  const enrichedSteps = steps.map((step, i) => {
    if (i === 0 && (title || startDate)) {
      const extraItems: SummaryStepItem[] = [];
      if (title) {
        extraItems.push({ icon: IconLink, text: title });
      }
      if (startDate) {
        extraItems.push({ icon: IconClock, text: `Empieza en ${startDate}` });
      }
      // Only add if step doesn't already have its own items
      if (step.items && step.items.length > 0) {
        return step; // already has items, don't override
      }
      return { ...step, items: extraItems.length > 0 ? extraItems : step.items };
    }
    return step;
  });

  return (

    <div style={{ position: "sticky", top: 16, display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Help card */}
      {helpCard !== null && (helpCard ?? <DefaultHelpCard />)}

      {/* Above summary slot (e.g. FBT preview) */}
      {aboveSummary}

      {/* Summary card */}
      <div className="b-card">
        <div className="b-card-header">Resumen</div>
        <div className="b-card-body" style={{ padding: 0 }}>
          <div style={{ position: "relative", padding: "16px 20px" }}>
            {/* Vertical timeline line */}
            <div
              style={{
                position: "absolute",
                left: 30,
                top: 30,
                bottom: 16,
                width: 1,
                borderLeft: "1px solid #ebebeb",
              }}
            />

            {enrichedSteps.map((step, i) => (
              <div
                key={i}
                style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: i < enrichedSteps.length - 1 ? 16 : 0 }}
              >
                <Dot checked={step.checked} />
                <div style={{ flex: 1 }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: step.checked ? "var(--text)" : "var(--text-sub)",
                      cursor: "pointer",
                    }}
                  >
                    {step.label}
                    {step.optional && !step.checked && (
                      <span style={{ fontWeight: 400 }}> (opcional)</span>
                    )}
                  </div>

                  {step.checked && step.items && step.items.length > 0 ? (
                    <div style={{ paddingLeft: 0, marginTop: 4 }}>
                      {step.items.map((item, j) => (
                        <div key={j} style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
                          <StepIcon icon={item.icon} />
                          {item.text ? (
                            <span style={{ fontSize: 12, color: "var(--text-sub)" }}>{item.text}</span>
                          ) : item.lines ? (
                            <div style={{ display: "flex", flexDirection: "column" }}>
                              {item.lines.map((l, k) => (
                                <span key={k} style={{ fontSize: 12, color: "var(--text-sub)" }}>{l}</span>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : !step.checked ? (
                    <div
                      style={{
                        fontSize: 12,
                        color: step.emptyText ? "var(--text-muted)" : "var(--text-muted)",
                        marginTop: 2,
                        cursor: "pointer",
                      }}
                    >
                      {step.emptyText ?? "+ Haga clic para agregar"}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Below summary slot */}
      {belowSummary}
    </div>
  );
}
