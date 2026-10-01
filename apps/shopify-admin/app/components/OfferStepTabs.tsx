import { NavLink } from "react-router";

export type OfferStepKey =
  | "conditions"
  | "codes"
  | "rewards"
  | "combination"
  | "schedule"
  | "widget"
  | "preview";

const STEPS: Array<{ key: OfferStepKey; label: string; path: string }> = [
  { key: "conditions", label: "Conditions", path: "conditions" },
  { key: "codes", label: "Codes", path: "codes" },
  { key: "rewards", label: "Rewards", path: "rewards" },
  { key: "combination", label: "Combination", path: "combination" },
  { key: "schedule", label: "Schedule", path: "schedule" },
  { key: "widget", label: "Widgets", path: "widget" },
  { key: "preview", label: "Preview", path: "preview" },
];

/**
 * Shared tab bar for the offer step editor (Conditions/Rewards/Combination/
 * Schedule/Widgets/Preview). Renders as real links with an active indicator
 * so it's clear these are navigable tabs, not one-off action buttons, and
 * that the same offer is being edited across every step.
 */
export function OfferStepTabs({ offerId, active }: { offerId: string; active?: OfferStepKey }) {
  return (
    <nav className="b-tabs" aria-label="Offer configuration steps">
      <ul className="b-tabs-list">
        {STEPS.map((step) => (
          <li key={step.key}>
            <NavLink
              to={`/app/offers/${offerId}/${step.path}`}
              className={`b-tab${active === step.key ? " active" : ""}`}
            >
              {step.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
