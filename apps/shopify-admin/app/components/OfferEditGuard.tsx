import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useBlocker, useNavigation } from "react-router";
import { SaveBar } from "@shopify/app-bridge-react";
import { ConfirmDialog } from "./ConfirmDialog.js";

const NON_EDIT_INPUT_TYPES = new Set(["button", "submit", "reset", "search"]);

/**
 * Unsaved-changes guard for every /app/offers/:id/* edit route (mounted once in the layout route).
 * Any input/change inside a POST <form> marks that form dirty until it is submitted; forms or controls
 * that are not edits (simulators, row selection, filters) opt out with `data-no-dirty`. Dirty state shows
 * the App Bridge save bar (Save submits the form, Discard remounts the page from loader data), prompts
 * before in-app navigation, and sets a beforeunload warning.
 */
export function OfferEditGuard({ children }: { children: ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dirtyForms = useRef(new Set<HTMLFormElement>());
  const lastSubmitted = useRef<HTMLFormElement | null>(null);
  const [dirty, setDirty] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const navigation = useNavigation();

  const sync = useCallback(() => {
    for (const form of dirtyForms.current) if (!form.isConnected) dirtyForms.current.delete(form);
    setDirty(dirtyForms.current.size > 0);
  }, []);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const onEdit = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target instanceof HTMLInputElement && NON_EDIT_INPUT_TYPES.has(target.type)) return;
      if (target.closest("[data-no-dirty]")) return;
      const form = target.closest("form");
      if (!form || form.method.toLowerCase() !== "post") return;
      dirtyForms.current.add(form);
      sync();
    };
    const onSubmit = (event: Event) => {
      if (!(event.target instanceof HTMLFormElement)) return;
      lastSubmitted.current = event.target;
      dirtyForms.current.delete(event.target);
      sync();
    };
    node.addEventListener("input", onEdit);
    node.addEventListener("change", onEdit);
    node.addEventListener("submit", onSubmit);
    return () => {
      node.removeEventListener("input", onEdit);
      node.removeEventListener("change", onEdit);
      node.removeEventListener("submit", onSubmit);
    };
  }, [sync]);

  // A rejected save keeps the merchant's values on screen, so the form is still unsaved.
  const wasBusy = useRef(false);
  useEffect(() => {
    const busy = navigation.state !== "idle";
    if (wasBusy.current && !busy && lastSubmitted.current?.isConnected && containerRef.current?.querySelector('[role="alert"]')) {
      dirtyForms.current.add(lastSubmitted.current);
      sync();
    }
    if (!busy) lastSubmitted.current = lastSubmitted.current?.isConnected ? lastSubmitted.current : null;
    wasBusy.current = busy;
  }, [navigation.state, sync]);

  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);

  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const save = () => {
    const forms = [...dirtyForms.current].filter((form) => form.isConnected);
    forms[forms.length - 1]?.requestSubmit();
  };
  const discard = () => {
    dirtyForms.current.clear();
    setDirty(false);
    setResetKey((key) => key + 1);
  };

  return (
    <>
      <div ref={containerRef} key={resetKey}>
        {children}
      </div>
      <SaveBar id="offer-edit-save-bar" open={dirty}>
        <button {...({ variant: "primary" } as object)} onClick={save}>Save</button>
        <button onClick={discard}>Discard</button>
      </SaveBar>
      <ConfirmDialog
        open={blocker.state === "blocked"}
        ariaLabel="Unsaved changes"
        title="Discard unsaved changes?"
        message="You have changes on this page that have not been saved. If you leave now they will be lost."
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        onConfirm={() => blocker.proceed?.()}
        onCancel={() => blocker.reset?.()}
      />
    </>
  );
}
