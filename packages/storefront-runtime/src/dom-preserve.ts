/** Keeps the shopper's place when the cart drawer's HTML is swapped out from under them. */

const NON_TEXT_INPUTS = new Set([
  "button", "submit", "reset", "checkbox", "radio", "image", "file", "range", "color",
]);

export function isTextEntry(el: Element | null): el is HTMLElement {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") return !NON_TEXT_INPUTS.has(((el as HTMLInputElement).type || "text").toLowerCase());
  return (el as HTMLElement).isContentEditable === true;
}

/** True when the shopper is typing into a field inside `root` (replacing it would eat their input). */
export function isEditingWithin(root: Element, active: Element | null = document.activeElement): boolean {
  return !!active && root.contains(active) && isTextEntry(active);
}

export interface UiSnapshot {
  scrolls: Array<[number, number]>;
  windowScroll: [number, number];
  focus: { id: string; name: string; tag: string; nth: number; start: number | null; end: number | null } | null;
}

function descendants(root: Element): Element[] {
  return [root, ...Array.from(root.querySelectorAll("*"))];
}

export function captureUi(root: Element): UiSnapshot {
  const scrolls: Array<[number, number]> = [];
  descendants(root).forEach((el, i) => {
    if (el.scrollTop > 0) scrolls.push([i, el.scrollTop]);
  });
  const active = document.activeElement;
  let focus: UiSnapshot["focus"] = null;
  if (active instanceof HTMLElement && active !== document.body && root.contains(active)) {
    const name = active.getAttribute("name") ?? "";
    const same = Array.from(root.querySelectorAll(active.tagName)).filter(
      (el) => (el.getAttribute("name") ?? "") === name,
    );
    let start: number | null = null;
    let end: number | null = null;
    try {
      start = (active as HTMLInputElement).selectionStart;
      end = (active as HTMLInputElement).selectionEnd;
    } catch {
      // number/email inputs throw on selection access.
    }
    focus = { id: active.id, name, tag: active.tagName, nth: same.indexOf(active), start, end };
  }
  return { scrolls, windowScroll: [window.scrollX, window.scrollY], focus };
}

export function restoreUi(root: Element, snap: UiSnapshot): void {
  const all = descendants(root);
  for (const [i, top] of snap.scrolls) {
    if (all[i]) all[i]!.scrollTop = top;
  }
  const f = snap.focus;
  if (f) {
    let target: Element | null = f.id ? root.querySelector(`[id="${f.id.replace(/"/g, '\\"')}"]`) : null;
    if (!target) {
      const same = Array.from(root.querySelectorAll(f.tag)).filter((el) => (el.getAttribute("name") ?? "") === f.name);
      target = same[Math.max(0, f.nth)] ?? null;
    }
    if (target instanceof HTMLElement) {
      target.focus({ preventScroll: true });
      if (f.start !== null && f.end !== null) {
        try {
          (target as HTMLInputElement).setSelectionRange(f.start, f.end);
        } catch {
          // not a text control
        }
      }
    }
  }
  if (window.scrollX !== snap.windowScroll[0] || window.scrollY !== snap.windowScroll[1]) {
    window.scrollTo(snap.windowScroll[0], snap.windowScroll[1]);
  }
}
