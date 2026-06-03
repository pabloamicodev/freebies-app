/** Offer status badge — shared across All Offers, Boosters, Analytics, etc. */
export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { cls: string; label: string }> = {
    active:   { cls: "b-badge b-badge-green",   label: "Active" },
    paused:   { cls: "b-badge b-badge-gray",     label: "Disabled" },
    scheduled:{ cls: "b-badge b-badge-blue",     label: "Scheduled" },
    expired:  { cls: "b-badge b-badge-orange",   label: "Expired" },
    draft:    { cls: "b-badge b-badge-gray",     label: "Draft" },
    archived: { cls: "b-badge b-badge-gray",     label: "Archived" },
  };
  const v = map[status] ?? { cls: "b-badge b-badge-gray", label: status };
  return <span className={v.cls}>{v.label}</span>;
}
