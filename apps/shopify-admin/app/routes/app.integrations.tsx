import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server.js";
import type { LoaderFunctionArgs } from "react-router";
import { useState } from "react";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return { connected: [] };
};

const INTEGRATIONS = [
  {
    id: "klaviyo",
    name: "Klaviyo",
    initial: "K",
    color: "#7c3aed",
    description: "Sync gift events to Klaviyo flows and segments",
  },
  {
    id: "rebuy",
    name: "Rebuy",
    initial: "R",
    color: "#2c6ecb",
    description: "Use BOGOS offers in Rebuy Smart Cart widgets",
  },
  {
    id: "omnisend",
    name: "Omnisend",
    initial: "O",
    color: "#16a34a",
    description: "Trigger Omnisend automations on gift events",
  },
  {
    id: "attentive",
    name: "Attentive",
    initial: "A",
    color: "#ea580c",
    description: "Send gift SMS notifications via Attentive",
  },
  {
    id: "gorgias",
    name: "Gorgias",
    initial: "G",
    color: "#dc2626",
    description: "Access offer data in Gorgias support tickets",
  },
  {
    id: "postscript",
    name: "Postscript",
    initial: "P",
    color: "#4f46e5",
    description: "BOGOS gift events in Postscript SMS flows",
  },
];

export default function IntegrationsPage() {
  const { connected } = useLoaderData<typeof loader>();

  const [connectedSet, setConnectedSet] = useState<Set<string>>(
    new Set(connected)
  );
  const [requestEmail, setRequestEmail] = useState("");
  const [requestSubmitted, setRequestSubmitted] = useState(false);

  function handleConnect(id: string) {
    setConnectedSet((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }

  function handleDisconnect(id: string) {
    setConnectedSet((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  function handleRequestSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (requestEmail.trim()) {
      setRequestSubmitted(true);
      setRequestEmail("");
    }
  }

  return (
    <div className="b-page" style={{ padding: "24px", maxWidth: "1200px", margin: "0 auto" }}>
      {/* Header */}
      <div style={{ marginBottom: "24px" }}>
        <h1
          style={{
            fontSize: "24px",
            fontWeight: "700",
            color: "#1a1a1a",
            margin: "0 0 4px 0",
          }}
        >
          Integrations
        </h1>
      </div>

      {/* Banner */}
      <div
        className="b-banner rd-style-001"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 20 20"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          style={{ flexShrink: 0 }}
        >
          <circle cx="10" cy="10" r="9" stroke="#3b82f6" strokeWidth="2" />
          <path
            d="M10 9v5M10 7v.5"
            stroke="#3b82f6"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
        Connect BOGOS with your favorite marketing and analytics tools
      </div>

      {/* Integration Cards Grid */}
      <div
        className="b-grid-3"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "16px",
          marginBottom: "28px",
        }}
      >
        {INTEGRATIONS.map((integration) => {
          const isConnected = connectedSet.has(integration.id);
          return (
            <div
              key={integration.id}
              className="b-card b-card-body rd-style-002"
            >
              {/* Icon + Name row */}
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <div
                  className="rd-style-003" style={{ backgroundColor: integration.color }}
                >
                  {integration.initial}
                </div>
                <span style={{ fontWeight: "700", fontSize: "15px", color: "#1a1a1a" }}>
                  {integration.name}
                </span>
              </div>

              {/* Description */}
              <p
                style={{
                  margin: 0,
                  fontSize: "13px",
                  color: "#6b7280",
                  lineHeight: "1.5",
                  flexGrow: 1,
                }}
              >
                {integration.description}
              </p>

              {/* Status badge + action */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "8px",
                }}
              >
                {/* Status Badge */}
                <span
                  className="rd-style-004" style={{ backgroundColor: isConnected ? "#dcfce7" : "#f3f4f6", color: isConnected ? "#16a34a" : "#6b7280" }}
                >
                  <span
                    style={{
                      width: "6px",
                      height: "6px",
                      borderRadius: "50%",
                      backgroundColor: isConnected ? "#16a34a" : "#9ca3af",
                      display: "inline-block",
                    }}
                  />
                  {isConnected ? "Connected" : "Not connected"}
                </span>

                {/* Action Button */}
                {isConnected ? (
                  <button type="button"
                    onClick={() => handleDisconnect(integration.id)}
                    className="rd-style-005"
                  >
                    Disconnect
                  </button>
                ) : (
                  <button type="button"
                    onClick={() => handleConnect(integration.id)}
                    className="rd-style-006"
                  >
                    Connect
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Request an Integration */}
      <div
        className="b-card b-card-body"
        style={{
          backgroundColor: "#ffffff",
          border: "1px solid #e5e7eb",
          borderRadius: "10px",
          padding: "24px",
          boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
          maxWidth: "560px",
        }}
      >
        <h2
          style={{
            fontSize: "16px",
            fontWeight: "700",
            color: "#1a1a1a",
            margin: "0 0 6px 0",
          }}
        >
          Request an integration
        </h2>
        <p
          style={{
            fontSize: "13px",
            color: "#6b7280",
            margin: "0 0 16px 0",
            lineHeight: "1.5",
          }}
        >
          Don't see the tool you need? Let us know and we'll add it to our roadmap.
        </p>

        {requestSubmitted ? (
          <div
            style={{
              backgroundColor: "#f0fdf4",
              border: "1px solid #bbf7d0",
              borderRadius: "6px",
              padding: "12px 16px",
              fontSize: "13px",
              color: "#15803d",
              fontWeight: "500",
            }}
          >
            Thanks! We've received your request and will be in touch.
          </div>
        ) : (
          <form onSubmit={handleRequestSubmit} style={{ display: "flex", gap: "10px" }}>
            <input
              aria-label="Request integration email"
              type="email"
              placeholder="your@email.com"
              value={requestEmail}
              onChange={(e) => setRequestEmail(e.target.value)}
              required
              style={{
                flex: 1,
                border: "1px solid #d1d5db",
                borderRadius: "6px",
                padding: "8px 12px",
                fontSize: "13px",
                color: "#1a1a1a",
                backgroundColor: "#fafafa",
              }}
            />
            <button
              type="submit"
              className="rd-style-007"
            >
              Submit
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
