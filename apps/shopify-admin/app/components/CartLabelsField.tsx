import { useState } from "react";
import { CART_LABEL_MAX_COUNT, CART_LABEL_MAX_LENGTH } from "../lib/cart-labels.js";

interface Props {
  value: string[];
  onChange: (labels: string[]) => void;
  /** Hidden input carrying the JSON array; pass "" when the caller serializes it itself. */
  name?: string;
  label?: string;
  compact?: boolean;
  onBlur?: () => void;
}

export function CartLabelsField({ value, onChange, name = "cartLabels", label = "Cart & checkout labels", compact, onBlur }: Props) {
  const [draft, setDraft] = useState("");
  const full = value.length >= CART_LABEL_MAX_COUNT;

  const commit = (text: string) => {
    const next = text.trim();
    setDraft("");
    if (!next || full || value.includes(next)) return;
    onChange([...value, next.slice(0, CART_LABEL_MAX_LENGTH)]);
  };

  return (
    <div>
      {!compact && <label className="b-label">{label}</label>}
      {name && <input type="hidden" name={name} value={JSON.stringify(value)} />}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        {value.map((item) => (
          <span key={item} className="b-badge" style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
            {item}
            <button
              type="button"
              aria-label={`Remove label ${item}`}
              onClick={() => {
                onChange(value.filter((v) => v !== item));
                onBlur?.();
              }}
              style={{ background: "none", border: 0, cursor: "pointer", padding: 0, lineHeight: 1 }}
            >
              ×
            </button>
          </span>
        ))}
        <input
          className="b-input"
          style={{ flex: "1 1 140px", minWidth: 140 }}
          aria-label={label}
          value={draft}
          maxLength={CART_LABEL_MAX_LENGTH}
          disabled={full}
          placeholder={full ? `Max ${CART_LABEL_MAX_COUNT} labels` : "Type a label, press Enter"}
          autoComplete="off"
          onChange={(event) => {
            const text = event.target.value;
            if (!text.includes(",")) return setDraft(text);
            const next = [...value];
            for (const part of text.split(",").map((p) => p.trim().slice(0, CART_LABEL_MAX_LENGTH))) {
              if (part && next.length < CART_LABEL_MAX_COUNT && !next.includes(part)) next.push(part);
            }
            setDraft("");
            onChange(next);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit(draft);
              onBlur?.();
            }
          }}
          onBlur={() => {
            commit(draft);
            onBlur?.();
          }}
        />
      </div>
      {!compact && (
        <p className="b-help">
          Up to {CART_LABEL_MAX_COUNT} labels, {CART_LABEL_MAX_LENGTH} characters each. Shown after the discount message in the cart and checkout.
        </p>
      )}
    </div>
  );
}
