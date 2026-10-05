import { DISCOUNT_MESSAGE_MAX_LENGTH } from "../lib/discount-message.js";

interface Props {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  name?: string;
  /** Used when the field is left empty. */
  fallbackLabel?: string;
  onBlur?: () => void;
}

export function DiscountMessageField({ value, onChange, id = "publicTitle", name = "publicTitle", fallbackLabel = "the offer name", onBlur }: Props) {
  return (
    <div>
      <label className="b-label" htmlFor={id}>Discount message (shown in cart, checkout and orders)</label>
      <input
        id={id}
        name={name}
        className="b-input"
        value={value}
        maxLength={DISCOUNT_MESSAGE_MAX_LENGTH}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        autoComplete="off"
      />
      <p className="b-help">
        {value.length}/{DISCOUNT_MESSAGE_MAX_LENGTH} · Customers see it next to the discount, and Shopify records it on the order. Leave empty to use {fallbackLabel}.
      </p>
    </div>
  );
}
