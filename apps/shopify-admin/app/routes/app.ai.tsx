/**
 * AI Assistant — Section 25 of the spec.
 * Natural language offer creation using Claude API.
 * Draft-only: never auto-publishes. All outputs are auditable.
 *
 * IMPORTANT: Only build after core engine is stable.
 * This is a DRAFT implementation to satisfy the spec requirement.
 */

import { Form, useActionData } from "react-router";
import { useState, useRef, useEffect } from "react";
import { authenticate } from "../shopify.server.js";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import "../styles/bogos.css";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return {};
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const formData = await request.formData();
  const prompt = formData.get("prompt") as string;
  const intent = formData.get("intent") as string;

  if (intent === "generate_offer") {
    // Placeholder: In production, call Claude API to generate offer config
    // from the natural language prompt.
    // NEVER auto-publish — always return as draft for merchant review.
    return {
      suggestion: {
        type: "gift",
        internalName: "ai-generated-offer",
        publicTitle: "AI Suggested: Free Gift with Purchase",
        priority: 100,
        conditions: [{ type: "cart_value", threshold: 50, currency: "USD" }],
        rewards: [{ type: "product_gift", discountType: "free", isAutoAdd: true }],
        reasoning: `Based on your prompt: "${prompt}", I suggest a free gift offer that triggers when cart value reaches $50.`,
        isDraft: true,
      },
    };
  }

  if (intent === "explain_offer") {
    return {
      explanation: "This offer qualifies when the cart subtotal exceeds $50 (excluding gift lines). The Discount Function validates eligibility at checkout.",
    };
  }

  return { error: "Unknown intent" };
};

type Message =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; isDraft?: boolean; title?: string };

export default function AiAssistantPage() {
  const actionData = useActionData<typeof action>();
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      text: "Hi! I can help you generate offer configurations from natural language. Describe the offer you want to create and I'll build a draft for you to review.",
    },
  ]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const prevActionData = useRef<typeof actionData>(undefined);

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Append assistant reply when actionData arrives
  useEffect(() => {
    if (!actionData || actionData === prevActionData.current) return;
    prevActionData.current = actionData;

    if ("suggestion" in actionData && actionData.suggestion) {
      const s = actionData.suggestion;
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: s.reasoning,
          isDraft: true,
          title: s.publicTitle,
        },
      ]);
    } else if ("explanation" in actionData && actionData.explanation) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: actionData.explanation as string },
      ]);
    } else if ("error" in actionData && actionData.error) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: `Error: ${actionData.error}` },
      ]);
    }
  }, [actionData]);

  function handleSend() {
    const text = input.trim();
    if (!text) return;
    setMessages((prev) => [...prev, { role: "user", text }]);
    setInput("");
    // Submit the hidden form programmatically
    formRef.current?.requestSubmit();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="b-page" style={{ display: "flex", flexDirection: "column", height: "100vh", padding: 0 }}>
      {/* Header */}
      <div className="b-page-header" style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", background: "var(--bg-card)", marginBottom: 0, flexShrink: 0 }}>
        <div className="b-page-title-row">
          <h1 className="b-page-title">AI Assistant</h1>
          <span className="b-badge b-badge-blue">Beta</span>
        </div>
        <div className="b-page-actions">
          <span className="b-text-sm b-text-sub">Draft-only — no auto-publish</span>
        </div>
      </div>

      {/* Info banner */}
      <div style={{ padding: "12px 20px 0", flexShrink: 0 }}>
        <div className="b-banner">
          <span className="b-banner-icon">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" style={{ color: "var(--blue)" }}>
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
            </svg>
          </span>
          <div className="b-banner-body">
            <p className="b-banner-text">
              The AI assistant creates <strong>draft offers only</strong>. Always review and publish manually. No offer is auto-published without your approval.
            </p>
          </div>
        </div>
      </div>

      {/* Message list */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "16px 20px",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
        }}
      >
        {messages.map((msg, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              justifyContent: msg.role === "user" ? "flex-end" : "flex-start",
            }}
          >
            {msg.role === "assistant" && (
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: "50%",
                  background: "var(--blue-light)",
                  border: "1px solid var(--blue-border)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  marginRight: 8,
                  marginTop: 2,
                  fontSize: 14,
                }}
              >
                ✦
              </div>
            )}
            <div style={{ maxWidth: "72%" }}>
              {msg.role === "assistant" && msg.isDraft && msg.title && (
                <div
                  className="b-card"
                  style={{ marginBottom: 6 }}
                >
                  <div className="b-card-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span>{msg.title}</span>
                    <span className="b-badge b-badge-orange">Draft</span>
                  </div>
                  <div className="b-card-body" style={{ paddingTop: 12, paddingBottom: 12 }}>
                    <p className="b-text-sm b-text-sub" style={{ margin: "0 0 10px" }}>{msg.text}</p>
                    <a href="/app/offers/new" className="b-btn b-btn-secondary b-btn-sm">
                      Create This Offer Manually →
                    </a>
                  </div>
                </div>
              )}
              {(msg.role !== "assistant" || !msg.isDraft) && (
                <div
                  style={{
                    padding: "10px 14px",
                    borderRadius: msg.role === "user" ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
                    background: msg.role === "user" ? "var(--blue)" : "var(--bg-card)",
                    color: msg.role === "user" ? "#fff" : "var(--text)",
                    border: msg.role === "user" ? "none" : "1px solid var(--border)",
                    boxShadow: "var(--shadow)",
                    fontSize: 14,
                    lineHeight: 1.5,
                  }}
                >
                  {msg.text}
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Hidden form for server action */}
      <Form method="POST" ref={formRef} style={{ display: "none" }}>
        <input type="hidden" name="prompt" value={input} />
        <input type="hidden" name="intent" value="generate_offer" />
      </Form>

      {/* Input area */}
      <div
        style={{
          flexShrink: 0,
          borderTop: "1px solid var(--border)",
          padding: "12px 20px",
          background: "var(--bg-card)",
          display: "flex",
          alignItems: "flex-end",
          gap: "10px",
        }}
      >
        <textarea
          className="b-input"
          style={{
            flex: 1,
            resize: "none",
            minHeight: 40,
            maxHeight: 120,
            paddingTop: 9,
            paddingBottom: 9,
            lineHeight: 1.4,
            overflow: "auto",
          }}
          placeholder="e.g. Give customers a free sample when they spend over $75, but only for first-time buyers with the VIP tag"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
        />
        <button
          type="button"
          className="b-btn b-btn-primary"
          style={{ flexShrink: 0, alignSelf: "flex-end" }}
          onClick={handleSend}
          disabled={!input.trim()}
        >
          Send
        </button>
      </div>
    </div>
  );
}
