import type { ReactNode } from "react";
import { useNavigate } from "react-router";

// Header + numbered section card used by the offer-creation wizards
// (same markup as the gift/shipping $template pages, parameterised by accent).

export interface WizardAccent {
  color: string;
  gradient: string;
  soft: string;
}

export function OfferWizardHeader({
  title,
  subtitle,
  badge,
  icon,
  accent,
  backTo = "/app/offers",
  backLabel = "All Offers",
}: {
  title: string;
  subtitle: string;
  badge: string;
  icon: ReactNode;
  accent: WizardAccent;
  backTo?: string;
  backLabel?: string;
}) {
  const navigate = useNavigate();
  return (
    <div style={{ marginBottom: 28 }}>
      <button
        type="button"
        className="b-btn-plain b-text-sm"
        style={{ display: "inline-flex", alignItems: "center", gap: 4, marginBottom: 14 }}
        onClick={() => void navigate(backTo)}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M15 18l-6-6 6-6" />
        </svg>
        {backLabel}
      </button>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div
          aria-hidden="true"
          style={{
            width: 44,
            height: 44,
            borderRadius: 14,
            background: accent.gradient,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            boxShadow: `0 4px 14px ${accent.soft}`,
          }}
        >
          {icon}
        </div>
        <div>
          <h1
            style={{
              margin: 0,
              fontFamily: "var(--font-display)",
              fontSize: 22,
              fontWeight: 700,
              color: "var(--text)",
              lineHeight: 1.2,
            }}
          >
            {title}
          </h1>
          <div style={{ fontSize: 12, color: "var(--text-sub)", marginTop: 2 }}>{subtitle}</div>
        </div>
        <span
          style={{
            marginLeft: "auto",
            background: accent.soft,
            color: accent.color,
            border: `1.5px solid ${accent.soft}`,
            borderRadius: 20,
            fontSize: 12,
            fontWeight: 700,
            padding: "4px 12px",
            letterSpacing: "0.2px",
          }}
        >
          {badge}
        </span>
      </div>
    </div>
  );
}

export function OfferWizardSection({
  step,
  title,
  accent,
  children,
}: {
  step: number;
  title: string;
  accent: WizardAccent;
  children: ReactNode;
}) {
  return (
    <section className="b-card" style={step === 1 ? { borderTop: `3px solid ${accent.color}` } : undefined}>
      <div className="b-card-header" style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          aria-hidden="true"
          style={{
            width: 22,
            height: 22,
            borderRadius: "50%",
            background: accent.color,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 12,
            fontWeight: 700,
            color: "white",
            flexShrink: 0,
          }}
        >
          {step}
        </span>
        <h2 style={{ margin: 0, fontSize: "inherit", fontFamily: "var(--font-display)", fontWeight: 600 }}>
          {title}
        </h2>
      </div>
      <div className="b-card-body">{children}</div>
    </section>
  );
}
