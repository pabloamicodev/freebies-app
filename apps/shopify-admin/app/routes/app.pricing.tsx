import { useState } from "react";
import { useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server.js";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);
  return { currentPlan: "full" };
}

const FREE_FEATURES = [
  "Up to 2 active offers",
  "Basic gift offers",
  "Standard widgets",
  "Email support",
  "Basic analytics",
];

const PRO_FEATURES = [
  "Unlimited active offers",
  "All offer types (Bundle/Upsell/Discount)",
  "Advanced conditions",
  "Custom widget styling",
  "Priority support",
  "Advanced analytics",
  "Multi-currency",
  "Markets support",
];

const ENTERPRISE_FEATURES = [
  "Everything in Pro",
  "SLA support",
  "Custom integrations",
  "Onboarding",
  "Dedicated account manager",
];

const FAQ_ITEMS = [
  {
    question: "How does billing work?",
    answer:
      "You are billed monthly through your Shopify subscription. Charges appear on your Shopify invoice and are prorated if you upgrade or downgrade mid-cycle.",
  },
  {
    question: "Can I upgrade or downgrade at any time?",
    answer:
      "Yes. You can upgrade or downgrade your plan at any time from this page. When upgrading, new features are available immediately. When downgrading, your current plan stays active until the end of the billing period.",
  },
  {
    question: "What happens if I cancel?",
    answer:
      "If you cancel your subscription, your account will revert to the Free plan at the end of your current billing period. All your offer configurations will be saved but any offers that exceed Free plan limits will be paused.",
  },
];

function CheckIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ flexShrink: 0, marginTop: "2px" }}
    >
      <circle cx="8" cy="8" r="8" fill="#22c55e" fillOpacity="0.15" />
      <path
        d="M5 8l2 2 4-4"
        stroke="#16a34a"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FaqItem({ question, answer }: { question: string; answer: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div
      style={{
        borderBottom: "1px solid var(--b-border)",
        paddingBottom: "0",
      }}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "16px 0",
          background: "none",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
          gap: "12px",
        }}
      >
        <span
          style={{
            fontSize: "14px",
            fontWeight: 500,
            color: "var(--b-text-primary)",
          }}
        >
          {question}
        </span>
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          style={{
            flexShrink: 0,
            transition: "transform 0.2s ease",
            transform: open ? "rotate(180deg)" : "rotate(0deg)",
          }}
        >
          <path
            d="M4 6l4 4 4-4"
            stroke="var(--b-text-secondary)"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <div
          style={{
            paddingBottom: "16px",
            fontSize: "13px",
            color: "var(--b-text-secondary)",
            lineHeight: "1.6",
          }}
        >
          {answer}
        </div>
      )}
    </div>
  );
}

export default function PricingPage() {
  const { currentPlan } = useLoaderData<typeof loader>();

  return (
    <div className="b-page">
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "12px",
          marginBottom: "8px",
        }}
      >
        <h1 className="b-page-title">Pricing</h1>
        <span
          className="b-badge b-badge--success"
          style={{ fontSize: "13px", padding: "4px 12px" }}
        >
          Current plan: Full Plan
        </span>
      </div>

      {/* Subtitle */}
      <p
        style={{
          fontSize: "14px",
          color: "var(--b-text-secondary)",
          marginBottom: "32px",
        }}
      >
        Choose the plan that works for your store
      </p>

      {/* Plan cards */}
      <div className="b-grid-3" style={{ marginBottom: "48px" }}>
        {/* Free Plan */}
        <div className="b-card" style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ marginBottom: "20px" }}>
            <p
              style={{
                fontSize: "12px",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                color: "var(--b-text-secondary)",
                marginBottom: "8px",
              }}
            >
              Free
            </p>
            <div style={{ display: "flex", alignItems: "baseline", gap: "4px" }}>
              <span
                style={{
                  fontSize: "32px",
                  fontWeight: 700,
                  color: "var(--b-text-primary)",
                }}
              >
                $0
              </span>
              <span style={{ fontSize: "14px", color: "var(--b-text-secondary)" }}>
                /month
              </span>
            </div>
          </div>

          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: "0 0 24px 0",
              display: "flex",
              flexDirection: "column",
              gap: "10px",
              flex: 1,
            }}
          >
            {FREE_FEATURES.map((feature) => (
              <li
                key={feature}
                style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}
              >
                <CheckIcon />
                <span style={{ fontSize: "13px", color: "var(--b-text-secondary)" }}>
                  {feature}
                </span>
              </li>
            ))}
          </ul>

          {currentPlan === "free" ? (
            <span
              className="b-badge b-badge--success"
              style={{ textAlign: "center", padding: "8px 0", fontSize: "13px" }}
            >
              Current plan
            </span>
          ) : (
            <button className="b-btn b-btn--secondary" style={{ width: "100%" }}>
              Downgrade
            </button>
          )}
        </div>

        {/* Pro Plan */}
        <div
          className="b-card"
          style={{
            display: "flex",
            flexDirection: "column",
            border: "2px solid #2563eb",
            position: "relative",
          }}
        >
          <span
            style={{
              position: "absolute",
              top: "16px",
              right: "16px",
              background: "#fef08a",
              color: "#854d0e",
              fontSize: "11px",
              fontWeight: 600,
              padding: "3px 8px",
              borderRadius: "20px",
              border: "1px solid #fde047",
            }}
          >
            Most popular
          </span>

          <div style={{ marginBottom: "20px" }}>
            <p
              style={{
                fontSize: "12px",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                color: "#2563eb",
                marginBottom: "8px",
              }}
            >
              Pro
            </p>
            <div style={{ display: "flex", alignItems: "baseline", gap: "4px" }}>
              <span
                style={{
                  fontSize: "32px",
                  fontWeight: 700,
                  color: "var(--b-text-primary)",
                }}
              >
                $19
              </span>
              <span style={{ fontSize: "14px", color: "var(--b-text-secondary)" }}>
                /month
              </span>
            </div>
          </div>

          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: "0 0 24px 0",
              display: "flex",
              flexDirection: "column",
              gap: "10px",
              flex: 1,
            }}
          >
            {PRO_FEATURES.map((feature) => (
              <li
                key={feature}
                style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}
              >
                <CheckIcon />
                <span style={{ fontSize: "13px", color: "var(--b-text-secondary)" }}>
                  {feature}
                </span>
              </li>
            ))}
          </ul>

          {currentPlan === "pro" ? (
            <span
              className="b-badge b-badge--success"
              style={{ textAlign: "center", padding: "8px 0", fontSize: "13px" }}
            >
              Current plan
            </span>
          ) : (
            <button className="b-btn b-btn--primary" style={{ width: "100%" }}>
              Upgrade
            </button>
          )}
        </div>

        {/* Enterprise Plan */}
        <div className="b-card" style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ marginBottom: "20px" }}>
            <p
              style={{
                fontSize: "12px",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                color: "var(--b-text-secondary)",
                marginBottom: "8px",
              }}
            >
              Enterprise
            </p>
            <div style={{ display: "flex", alignItems: "baseline", gap: "4px" }}>
              <span
                style={{
                  fontSize: "32px",
                  fontWeight: 700,
                  color: "var(--b-text-primary)",
                }}
              >
                Custom
              </span>
            </div>
            <span style={{ fontSize: "12px", color: "var(--b-text-secondary)" }}>
              pricing
            </span>
          </div>

          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: "0 0 24px 0",
              display: "flex",
              flexDirection: "column",
              gap: "10px",
              flex: 1,
            }}
          >
            {ENTERPRISE_FEATURES.map((feature) => (
              <li
                key={feature}
                style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}
              >
                <CheckIcon />
                <span style={{ fontSize: "13px", color: "var(--b-text-secondary)" }}>
                  {feature}
                </span>
              </li>
            ))}
          </ul>

          {currentPlan === "enterprise" ? (
            <span
              className="b-badge b-badge--success"
              style={{ textAlign: "center", padding: "8px 0", fontSize: "13px" }}
            >
              Current plan
            </span>
          ) : (
            <button className="b-btn b-btn--secondary" style={{ width: "100%" }}>
              Contact us
            </button>
          )}
        </div>
      </div>

      {/* FAQ Section */}
      <div className="b-card" style={{ maxWidth: "720px" }}>
        <h2
          style={{
            fontSize: "16px",
            fontWeight: 600,
            color: "var(--b-text-primary)",
            marginBottom: "4px",
          }}
        >
          Frequently asked questions
        </h2>
        <p
          style={{
            fontSize: "13px",
            color: "var(--b-text-secondary)",
            marginBottom: "16px",
          }}
        >
          Everything you need to know about our plans
        </p>
        <div>
          {FAQ_ITEMS.map((item) => (
            <FaqItem key={item.question} question={item.question} answer={item.answer} />
          ))}
        </div>
      </div>
    </div>
  );
}
