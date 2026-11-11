// @vitest-environment jsdom
import { createRequire } from "node:module";
import { createElement, act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RouterProvider, createMemoryRouter, MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CapacityIncidentsBanner, CapacityIncidentsDialog, OPEN_CAPACITY_INCIDENTS_EVENT, resetCapacityDialogForTests } from "../components/CapacityIncidentsDialog.js";
import { CapacityIncidentsSection } from "../components/CapacityIncidentsSection.js";
import { CapacityWorkaroundList } from "../components/CapacityWorkaroundList.js";
import type { IncidentProposals, WorkaroundProposal, WorkaroundResult } from "./capacity-workarounds.js";

const require = createRequire(import.meta.url);
const axePath = require.resolve("axe-core", { paths: [require.resolve("@axe-core/playwright")] });
const axe = require(axePath) as {
  run(context: Element, options: unknown): Promise<{ violations: Array<{ id: string; help: string; nodes: Array<{ html: string }> }> }>;
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom's AbortSignal is not the one Node's Request checks for; the router only needs the request, not the abort.
const NodeRequest = globalThis.Request;
globalThis.Request = class extends NodeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    const { signal: _signal, body, ...rest } = init ?? {};
    const form = body && typeof body === "object" && "entries" in body ? (body as unknown as { entries(): Iterable<[string, string]> }) : null;
    super(input, form ? { ...rest, body: new URLSearchParams([...form.entries()]).toString(), headers: { ...(rest.headers as Record<string, string> | undefined), "content-type": "application/x-www-form-urlencoded" } } : { ...rest, ...(body ? { body } : {}) });
  }
} as typeof Request;

let root: Root | null = null;
let host: HTMLElement | null = null;
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

async function mount(element: ReactElement) {
  host = document.createElement("main");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(element));
  await flush();
  return host;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  root = host = null;
  resetCapacityDialogForTests();
});

beforeAll(() => {
  // jsdom has no layout, so axe cannot compute contrast; every other rule runs.
});

async function expectNoViolations(container: Element = document.body) {
  const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } }, runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] } });
  expect(results.violations.map((violation) => `${violation.id}: ${violation.help} ${violation.nodes.map((node) => node.html).join(" | ")}`)).toEqual([]);
}

const proposal = (over: Partial<WorkaroundProposal> & Pick<WorkaroundProposal, "kind">): WorkaroundProposal => ({
  title: "Select whole products instead of variants",
  summary: "Targets the products as a whole.",
  customerChange: "Nothing changes today. Variants you add to these products later will also be included.",
  semanticChange: false,
  offerVersions: { o1: "2026-11-10T00:00:00.000Z" },
  params: {},
  ...over,
});

const incident = (over: Partial<IncidentProposals> = {}): IncidentProposals => ({
  incidentId: "11111111-1111-4111-8111-111111111111",
  code: "OFFER_TOO_LARGE",
  reason: "AGGREGATING_REWARD",
  status: "open",
  occurrences: 3,
  lastSeenAt: "2026-11-10T10:00:00.000Z",
  source: "cron",
  offers: [{ id: "o1", name: "Spring sale", status: "paused" }],
  title: "This offer has too many items for one Shopify discount",
  limit: "One Shopify discount holds up to 9,500 bytes of offer configuration.",
  body: '"Spring sale" is too large for one Shopify discount.',
  fix: "Select fewer products.",
  proposals: [proposal({ kind: "use_whole_products" })],
  guidance: null,
  actions: [{ label: "Open Spring sale", to: "/app/offers/o1" }],
  ...over,
});

const noop = () => undefined;
const renderList = (props: Partial<Parameters<typeof CapacityWorkaroundList>[0]> = {}) =>
  mount(
    createElement(
      MemoryRouter,
      null,
      createElement(CapacityWorkaroundList, { incident: incident(), busyKind: null, result: null, onLoadOptions: noop, onApply: noop, onUndo: noop, onDismiss: noop, ...props }),
    ),
  );

const button = (name: RegExp | string) =>
  [...document.querySelectorAll("button")].find((b) => (typeof name === "string" ? b.textContent?.includes(name) : name.test(b.textContent ?? "")))!;
const click = (el: Element) => act(async () => void (el as HTMLElement).click());

describe("workaround list states", () => {
  it("shows the limit, the why, the offers and a fix with its customer-facing line; no confirmation needed without a semantic change", async () => {
    const onApply = vi.fn();
    const c = await renderList({ onApply });
    expect(c.textContent).toContain("One Shopify discount holds up to 9,500 bytes");
    expect(c.textContent).toContain("Seen 3 times");
    expect(c.textContent).toContain("What changes for customers");
    expect(c.textContent).toContain("Nothing changes today.");
    expect(c.querySelector('input[type="checkbox"]')).toBeNull();
    const apply = button("Apply") as HTMLButtonElement;
    expect(apply.disabled).toBe(false);
    await click(apply);
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ kind: "use_whole_products" }), [], false);
    await expectNoViolations();
  });

  it("a semantic change keeps Apply disabled until the confirmation is ticked", async () => {
    const onApply = vi.fn();
    await renderList({ incident: incident({ proposals: [proposal({ kind: "require_any", semanticChange: true, customerChange: "Customers qualify by buying any one of these 130 items instead of all of them." })] }), onApply });
    const apply = button("Apply") as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    const confirm = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(confirm.closest("label")?.textContent).toContain("I understand what changes for customers");
    await click(confirm);
    expect(apply.disabled).toBe(false);
    await click(apply);
    expect(onApply).toHaveBeenCalledWith(expect.anything(), [], true);
    await expectNoViolations();
  });

  it("pause_offers pre-checks the proposed set, lets it be edited and demands a minimum", async () => {
    const onApply = vi.fn();
    const pause = proposal({
      kind: "pause_offers",
      title: "Pause some offers",
      semanticChange: true,
      customerChange: "These offers stop running: tail-7.",
      options: { label: "Offers to pause", minSelected: 1, items: [{ id: "a", label: "tail-7", checked: true }, { id: "b", label: "tail-6", checked: false }] },
    });
    await renderList({ incident: incident({ proposals: [pause] }), onApply });
    const boxes = [...document.querySelectorAll<HTMLInputElement>("fieldset input[type=checkbox]")];
    expect(boxes.map((b) => b.checked)).toEqual([true, false]);
    await click([...document.querySelectorAll("label")].find((l) => l.textContent?.includes("I understand"))!.querySelector("input")!);
    await click(boxes[0]!);
    expect(document.body.textContent).toContain("Select at least 1.");
    expect((button("Apply") as HTMLButtonElement).disabled).toBe(true);
    await click(boxes[1]!);
    expect((button("Apply") as HTMLButtonElement).disabled).toBe(false);
    await click(button("Apply"));
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ kind: "pause_offers" }), ["b"], true);
    await expectNoViolations();
  });

  it("deactivating other Shopify discounts selects nothing for the merchant and loads the list on request", async () => {
    const onLoadOptions = vi.fn();
    const deactivate = proposal({
      kind: "deactivate_discounts",
      title: "Deactivate other Shopify discounts",
      semanticChange: true,
      customerChange: "The Shopify discounts you select stop applying in your store.",
      params: { needed: 2 },
      options: { label: "Automatic discounts to deactivate", minSelected: 2, items: [], lazy: true },
    });
    await renderList({ incident: incident({ code: "AUTOMATIC_DISCOUNT_LIMIT", proposals: [deactivate] }), onLoadOptions });
    await click(button("Show my Shopify discounts"));
    expect(onLoadOptions).toHaveBeenCalledTimes(1);
    await expectNoViolations();

    await act(async () => root!.unmount());
    host!.remove();
    await renderList({
      incident: incident({ code: "AUTOMATIC_DISCOUNT_LIMIT", proposals: [deactivate] }),
      lazyOptions: { state: "ready", items: [{ id: "d1", label: "Summer deal (Other app)", checked: false }, { id: "d2", label: "Free ship", checked: false }] },
    });
    const boxes = [...document.querySelectorAll<HTMLInputElement>("fieldset input[type=checkbox]")];
    expect(boxes.map((b) => b.checked)).toEqual([false, false]);
    expect(document.body.textContent).toContain("Select at least 2.");
    await click(boxes[0]!);
    expect(document.body.textContent).toContain("These Shopify discounts stop applying in your store: Summer deal (Other app).");
    await expectNoViolations();
  });

  it("loading and failed discount lists are announced", async () => {
    const deactivate = proposal({ kind: "deactivate_discounts", semanticChange: true, options: { label: "Automatic discounts", minSelected: 1, items: [], lazy: true } });
    await renderList({ incident: incident({ proposals: [deactivate] }), lazyOptions: { state: "loading", items: [] } });
    expect(button("Loading your discounts").getAttribute("aria-busy")).toBe("true");
    await expectNoViolations();
    await act(async () => root!.unmount());
    host!.remove();
    await renderList({ incident: incident({ proposals: [deactivate] }), lazyOptions: { state: "error", items: [] } });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load");
    await expectNoViolations();
  });

  it("applying: the busy button says so and every Apply is disabled", async () => {
    await renderList({ busyKind: "use_whole_products" });
    const apply = button("Applying") as HTMLButtonElement;
    expect(apply.getAttribute("aria-busy")).toBe("true");
    expect(apply.disabled).toBe(true);
    await expectNoViolations();
  });

  it("success: a live region announces it, the fixes are replaced by Undo", async () => {
    const onUndo = vi.fn();
    const result: WorkaroundResult = { ok: true, code: "applied", message: "Select whole products instead of variants: done. 1 offer still needs to be switched on: Spring sale.", actionId: "act-1" };
    await renderList({ result, onUndo });
    const live = document.querySelector('[role="status"][aria-live="polite"]');
    expect(live?.textContent).toContain("done.");
    expect(document.body.textContent).not.toContain("What changes for customers");
    await click(button("Undo"));
    expect(onUndo).toHaveBeenCalledWith("act-1");
    await expectNoViolations();
  });

  it.each([
    ["rolled back", { ok: false, code: "rolled_back", message: "Shopify exploded" } as WorkaroundResult],
    ["still doesn't fit", { ok: false, code: "still_blocked", message: "Still doesn't fit: The shared automatic config would be 12000B." } as WorkaroundResult],
    ["stale", { ok: false, code: "stale", message: "The offer changed; review the proposal again." } as WorkaroundResult],
  ])("%s: the error is an alert and the incident stays open with its fixes", async (_name, result) => {
    await renderList({ result });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(result.message);
    expect(button("Apply")).toBeDefined();
    await expectNoViolations();
  });

  it("with nothing to apply it shows the guidance and the offer link", async () => {
    await renderList({ incident: incident({ proposals: [], guidance: "Shopify can't check that a cart contains all of 130 items. Reduce the list to 100 or change the condition." }) });
    expect(document.body.textContent).toContain("Shopify can't check that a cart contains all of 130 items.");
    expect(document.querySelector('a[href="/app/offers/o1"]')?.textContent).toBe("Open Spring sale");
    await expectNoViolations();
  });

  it("compact mode shows only the fixes", async () => {
    await renderList({ compact: true });
    expect(document.body.textContent).not.toContain("One Shopify discount holds up to");
    expect(document.body.textContent).toContain("Apply");
    await expectNoViolations();
  });

  it("an incident dismissed from the list offers a Dismiss button that calls back", async () => {
    const onDismiss = vi.fn();
    await renderList({ onDismiss });
    await click(button("Dismiss"));
    expect(onDismiss).toHaveBeenCalled();
  });
});

type Handlers = { loader?: (args: { request: Request }) => unknown; action?: (args: { request: Request }) => unknown };

function mountApp(element: ReactElement, handlers: Handlers = {}) {
  const router = createMemoryRouter(
    [
      { path: "/app/capacity-incidents", loader: handlers.loader ?? (() => ({ incidents: [] })), action: handlers.action ?? (() => ({ ok: true, code: "applied", message: "Dismissed." })), element: null },
      { path: "*", element },
    ],
    { initialEntries: ["/app"] },
  );
  return mount(createElement(RouterProvider, { router }));
}

describe("dialog", () => {
  it("loading, then the list, then Apply and a success with Undo", async () => {
    let release: (value: unknown) => void = noop;
    const gate = new Promise((resolve) => (release = resolve));
    const actions: string[] = [];
    await mountApp(createElement(CapacityIncidentsDialog, { unsnoozed: 1 }), {
      loader: async () => {
        await gate;
        return { incidents: [incident()] };
      },
      action: async ({ request }: { request: Request }) => {
        const form = Object.fromEntries(await request.formData()) as Record<string, string>;
        actions.push(form["intent"]!);
        return form["intent"] === "undo"
          ? { ok: true, code: "undone", message: "Undone." }
          : { ok: true, code: "applied", message: "Select whole products instead of variants: done.", actionId: "act-9" };
      },
    });
    const dialog = document.querySelector("dialog")!;
    expect(dialog.getAttribute("aria-label")).toBe("Offers blocked by a Shopify limit");
    expect(dialog.textContent).toContain("Loading blocked offers…");
    await expectNoViolations();

    await act(async () => release(null));
    await flush();
    expect(dialog.textContent).toContain("Spring sale");
    await expectNoViolations();

    await click(button("Apply"));
    await flush();
    expect(actions).toEqual(["apply"]);
    expect(dialog.textContent).toContain("done.");
    await expectNoViolations();

    await click(button("Undo"));
    await flush();
    expect(actions).toEqual(["apply", "undo"]);
  });

  it("shows the empty state, and a load failure as an alert", async () => {
    await mountApp(createElement(CapacityIncidentsDialog, { unsnoozed: 1 }), { loader: () => ({ incidents: [] }) });
    expect(document.querySelector("dialog")!.textContent).toContain("No blocked offers. Everything fits.");
    await expectNoViolations();
    await act(async () => root!.unmount());
    host!.remove();
    resetCapacityDialogForTests();
    await mountApp(createElement(CapacityIncidentsDialog, { unsnoozed: 1 }), { loader: () => ({ error: true }) });
    expect(document.querySelector("dialog [role=alert]")?.textContent).toContain("Couldn't load the blocked offers");
    await expectNoViolations();
  });

  it("opens once per full app load, not on later mounts, and the banner reopens it", async () => {
    await mountApp(createElement(CapacityIncidentsDialog, { unsnoozed: 2 }));
    expect(document.querySelector("dialog")).not.toBeNull();
    await act(async () => root!.unmount());
    host!.remove();
    await mountApp(createElement("div", null, createElement(CapacityIncidentsDialog, { unsnoozed: 2 }), createElement(CapacityIncidentsBanner, { open: 2 })));
    expect(document.querySelector("dialog")).toBeNull();
    expect(document.body.textContent).toContain("2 offer groups are blocked by a Shopify limit.");
    await click(button("Review"));
    expect(document.querySelector("dialog")).not.toBeNull();
    expect(OPEN_CAPACITY_INCIDENTS_EVENT).toBe("capacity-incidents:open");
  });

  it("does not open without unsnoozed incidents, and the banner is hidden at zero", async () => {
    await mountApp(createElement("div", null, createElement(CapacityIncidentsDialog, { unsnoozed: 0 }), createElement(CapacityIncidentsBanner, { open: 0 })));
    expect(document.querySelector("dialog")).toBeNull();
    expect(document.querySelector(".b-banner")).toBeNull();
  });

  it("Not now snoozes through the action route and closes; Escape closes too", async () => {
    const intents: string[] = [];
    await mountApp(createElement(CapacityIncidentsDialog, { unsnoozed: 1 }), {
      action: async ({ request }: { request: Request }) => {
        intents.push(String((await request.formData()).get("intent")));
        return { ok: true, code: "applied", message: "ok" };
      },
    });
    await click(button("Not now"));
    await flush();
    expect(intents).toEqual(["snooze"]);
    expect(document.querySelector("dialog")).toBeNull();
    resetCapacityDialogForTests();
    await act(async () => root!.unmount());
    host!.remove();
    await mountApp(createElement(CapacityIncidentsDialog, { unsnoozed: 1 }));
    await act(async () => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(document.querySelector("dialog")).toBeNull();
  });
});

describe("diagnostics section", () => {
  const row = { id: "i1", code: "SLOT_FULL", status: "open", resolution: null, occurrences: 4, source: "cron", lastSeenAt: "2026-11-10T10:00:00.000Z", offers: ["Spring sale"] };
  it("lists incidents and offers Undo only while the window is open", async () => {
    const now = Date.parse("2026-11-10T12:00:00Z");
    const actions = [
      { id: "a1", incidentId: "i1", kind: "use_whole_products", status: "applied", appliedAt: "2026-11-10T10:00:00Z", undoUntil: "2026-11-11T10:00:00Z", error: null },
      { id: "a2", incidentId: "i2", kind: "pause_offers", status: "applied", appliedAt: "2026-11-08T10:00:00Z", undoUntil: "2026-11-09T10:00:00Z", error: null },
      { id: "a3", incidentId: "i3", kind: "split_offer", status: "rolled_back", appliedAt: null, undoUntil: null, error: "boom" },
    ];
    await mountApp(createElement(CapacityIncidentsSection, { open: [row], resolved: [{ ...row, id: "i2", status: "resolved", resolution: "workaround" }], actions, now }));
    expect(document.body.textContent).toContain("Shopify's discount size limit is reached");
    expect(document.body.textContent).toContain("Resolved (workaround)");
    expect(document.querySelectorAll("button")).toHaveLength(1);
    expect(document.body.textContent).toContain("rolled_back: boom");
    await expectNoViolations();
  });

  it("is quiet when there is nothing", async () => {
    await mountApp(createElement(CapacityIncidentsSection, { open: [], resolved: [], actions: [] }));
    expect(document.body.textContent).toContain("No capacity incidents.");
    await expectNoViolations();
  });
});
