/** Ticking a product row: all its selectable variants go in or out and the product counts as a whole-product pick. */
export function toggleProductSelection(
  selected: ReadonlySet<string>,
  whole: ReadonlySet<string>,
  productGid: string,
  variantGids: readonly string[],
  mode: "variants" | "products",
  allowMultiple: boolean,
): { selected: Set<string>; whole: Set<string> } {
  const next = new Set(selected);
  const marked = new Set(whole);
  if (mode === "products") {
    if (next.has(productGid)) next.delete(productGid);
    else {
      if (!allowMultiple) next.clear();
      next.add(productGid);
    }
    return { selected: next, whole: marked };
  }
  const allSelected = variantGids.every((v) => next.has(v));
  for (const v of variantGids) {
    if (allSelected) next.delete(v);
    else next.add(v);
  }
  if (allSelected) marked.delete(productGid);
  else marked.add(productGid);
  return { selected: next, whole: marked };
}
