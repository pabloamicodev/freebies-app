import { afterEach, describe, expect, it, vi } from "vitest";
import { captureUi, restoreUi } from "./dom-preserve.js";

class El {
  scrollTop = 0;
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  constructor(
    public tagName: string,
    public id = "",
    private attrs: Record<string, string> = {},
    public children: El[] = [],
  ) {}
  getAttribute(n: string) {
    return this.attrs[n] ?? null;
  }
  all(): El[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  querySelectorAll(sel: string) {
    const all = this.all();
    return sel === "*" ? all : all.filter((e) => e.tagName === sel);
  }
  querySelector(sel: string) {
    const m = /^\[id="(.*)"\]$/.exec(sel);
    return m ? (this.all().find((e) => e.id === m[1]) ?? null) : null;
  }
  contains(e: unknown) {
    return e === this || this.all().includes(e as El);
  }
  focus() {
    doc.activeElement = this;
  }
  setSelectionRange(a: number, b: number) {
    this.selectionStart = a;
    this.selectionEnd = b;
  }
}

const doc: { activeElement: El | null; body: El } = { activeElement: null, body: new El("BODY") };

function setup() {
  doc.activeElement = null;
  vi.stubGlobal("HTMLElement", El);
  vi.stubGlobal("document", doc);
  const win = { scrollX: 0, scrollY: 300, scrollTo: vi.fn() };
  vi.stubGlobal("window", win);
  return win;
}

afterEach(() => vi.unstubAllGlobals());

describe("refreshCartUI state preservation", () => {
  it("restores inner scroll, window scroll, focus (by id) and caret after the markup is replaced", () => {
    const win = setup();
    const list = new El("DIV", "list");
    list.scrollTop = 120;
    const note = new El("TEXTAREA", "note");
    note.selectionStart = 2;
    note.selectionEnd = 4;
    const root = new El("DIV", "drawer", {}, [list, note]);
    doc.activeElement = note;

    const snap = captureUi(root as never);

    const list2 = new El("DIV", "list");
    const note2 = new El("TEXTAREA", "note");
    root.children = [list2, note2];
    win.scrollY = 0;
    restoreUi(root as never, snap);

    expect(list2.scrollTop).toBe(120);
    expect(doc.activeElement).toBe(note2);
    expect([note2.selectionStart, note2.selectionEnd]).toEqual([2, 4]);
    expect(win.scrollTo).toHaveBeenCalledWith(0, 300);
  });

  it("falls back to name + position for fields without an id", () => {
    setup();
    const q1 = new El("INPUT", "", { name: "updates[]" });
    const q2 = new El("INPUT", "", { name: "updates[]" });
    const root = new El("DIV", "drawer", {}, [q1, q2]);
    doc.activeElement = q2;
    const snap = captureUi(root as never);
    const n1 = new El("INPUT", "", { name: "updates[]" });
    const n2 = new El("INPUT", "", { name: "updates[]" });
    root.children = [n1, n2];
    restoreUi(root as never, snap);
    expect(doc.activeElement).toBe(n2);
  });

  it("does nothing to focus when the shopper was not inside the section", () => {
    setup();
    const outside = new El("INPUT", "search");
    const root = new El("DIV", "drawer", {}, [new El("INPUT", "x")]);
    doc.activeElement = outside;
    const snap = captureUi(root as never);
    expect(snap.focus).toBeNull();
  });
});
