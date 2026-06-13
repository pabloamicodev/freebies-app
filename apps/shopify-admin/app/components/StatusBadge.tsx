const STATUS_MAP: Record<string, { cls: string; label: string }> = {
  active:    { cls: "b-badge b-badge-green",  label: "Active" },
  paused:    { cls: "b-badge b-badge-gray",   label: "Disabled" },
  scheduled: { cls: "b-badge b-badge-blue",   label: "Scheduled" },
  expired:   { cls: "b-badge b-badge-orange", label: "Expired" },
  draft:     { cls: "b-badge b-badge-gray",   label: "Draft" },
  archived:  { cls: "b-badge b-badge-gray",   label: "Archived" },
};

/** Offer status badge — shared across All Offers, Boosters, Analytics, etc. */
export function StatusBadge({ status }: { status: string }) {
  const v = STATUS_MAP[status] ?? { cls: "b-badge b-badge-gray", label: status };
  return <span className={v.cls}>{v.label}</span>;
}
