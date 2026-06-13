/**
 * AI Assistant — Section 25 of the spec.
 * Natural language offer creation using Claude API.
 * Draft-only: never auto-publishes. All outputs are auditable.
 *
 * IMPORTANT: Only build after core engine is stable.
 * This is a DRAFT implementation to satisfy the spec requirement.
 */

import { Form, Link, useActionData } from "react-router";
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
  // AI integration not yet available — guard all intents
  return { error: "AI assistant is not yet available. This feature is coming soon." };
};

type Message =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; text: string; isDraft?: boolean; title?: string };

function createMessageId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `message-${Date.now()}-${Math.random()}`;
}

export default function AiAssistantPage() {
  const actionData = useActionData<typeof action>();
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([
    {
      id: createMessageId(),
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

    if ("error" in actionData && actionData.error) {
      setMessages((prev) => [
        ...prev,
        { id: createMessageId(), role: "assistant", text: actionData.error as string },
      ]);
    }
  }, [actionData]);

  function handleSend() {
    const text = input.trim();
    if (!text) return;
    setMessages((prev) => [...prev, { id: createMessageId(), role: "user", text }]);
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
          <span className="b-badge b-badge-orange">Coming Soon</span>
        </div>
        <div className="b-page-actions">
          <span className="b-text-sm b-text-sub">Natural language offer creation</span>
        </div>
      </div>

      {/* Coming soon banner */}
      <div style={{ padding: "12px 20px 0", flexShrink: 0 }}>
        <div className="b-banner b-banner-orange">
          <span className="b-banner-icon">🚧</span>
          <div className="b-banner-body">
            <p className="b-banner-text" style={{ margin: 0 }}>
              <strong>AI assistant is not yet available.</strong> The Claude API integration is in development. This feature will let you generate offer configs from natural language prompts.
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
        {messages.map((msg) => (
          <div
            key={msg.id}
            style={{
              display: "flex",
              justifyContent: msg.role === "user" ? "flex-end" : "flex-start",
            }}
          >
            {msg.role === "assistant" && (
              <div
                className="rd-style-018"
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
                    <Link to="/app/offers/new" className="b-btn b-btn-secondary b-btn-sm">
                      Create This Offer Manually →
                    </Link>
                  </div>
                </div>
              )}
              {(msg.role !== "assistant" || !msg.isDraft) && (
                <div
                  className="rd-style-019" style={{ borderRadius: msg.role === "user" ? "12px 12px 2px 12px" : "12px 12px 12px 2px", background: msg.role === "user" ? "var(--blue)" : "var(--bg-card)", color: msg.role === "user" ? "#fff" : "var(--text)", border: msg.role === "user" ? "none" : "1px solid var(--border)" }}
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
          aria-label="AI assistant prompt"
          className="b-input rd-style-020"
          placeholder="AI assistant coming soon…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          disabled
        />
        <button
          type="button"
          className="b-btn b-btn-primary"
          style={{ flexShrink: 0, alignSelf: "flex-end" }}
          onClick={handleSend}
          disabled
        >
          Send
        </button>
      </div>
    </div>
  );
}
