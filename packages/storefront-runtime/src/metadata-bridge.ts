const METADATA_PROPERTY = "_promo_engine_metadata";
const LANDING_STORAGE_KEY = "promo_engine_utm_landing";

type LineProperties = Record<string, string>;

function existingMetadata(value: string | undefined): LineProperties {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

/**
 * Privacy / consent classification: the visit landing, the stamped page URL and the
 * session/declined-gift state are FUNCTIONAL ("strictly necessary") storage. They exist
 * only so a discount the shopper was promised on a page/UTM still applies at checkout,
 * and the gift they declined is not re-added. They are first-party, never sent to a
 * third party, and hold only the path + utm_* + the specific-link param names (D4);
 * emails, click ids (gclid/fbclid/_kx) and every other param are dropped. The landing
 * expires after 24 h. Analytics events (publishAnalytics) are the consent-gated part.
 */
const LANDING_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LINK_PARAMS = ["freegifts_code"];
const LINK_PARAMS_STORAGE_KEY = "promo_engine_link_params";

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

function localStorageOrUndefined(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** Specific-link param names: runtime config, else the last list the server sent, else the default. */
export function specificLinkParams(): string[] {
  const configured =
    typeof window !== "undefined" ? window.__promoEngineConfig?.specificLinkParams : undefined;
  const names = Array.isArray(configured) && configured.length > 0 ? configured : cachedLinkParams();
  const list = names.length > 0 ? names : DEFAULT_LINK_PARAMS;
  return list.filter((n): n is string => typeof n === "string" && n.length > 0).map((n) => n.toLowerCase());
}

function cachedLinkParams(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorageOrUndefined()?.getItem(LINK_PARAMS_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** Called with the evaluate response so stamping follows the offers' configured link params. */
export function rememberSpecificLinkParams(names: unknown): void {
  if (!Array.isArray(names)) return;
  const clean = names.filter((v): v is string => typeof v === "string" && v.length > 0).slice(0, 20);
  try {
    localStorageOrUndefined()?.setItem(LINK_PARAMS_STORAGE_KEY, JSON.stringify(clean));
  } catch {
    // Storage unavailable: the config/default list still applies.
  }
}

/** Path + utm_* + specific-link params only (D4). Raw query segments are kept as sent. */
export function sanitizePageUrl(raw: string, linkParams: string[] = specificLinkParams()): string {
  let path = raw;
  let query = "";
  try {
    const url = new URL(raw, "https://localhost");
    path = url.pathname;
    query = url.search.slice(1);
  } catch {
    const q = raw.indexOf("?");
    if (q >= 0) {
      path = raw.slice(0, q);
      query = raw.slice(q + 1).split("#")[0] ?? "";
    }
  }
  const kept = query.split("&").filter((segment) => {
    if (!segment) return false;
    const name = safeDecode(segment.split("=")[0] ?? "").toLowerCase();
    return name.startsWith("utm_") || linkParams.includes(name);
  });
  return kept.length > 0 ? `${path}?${kept.join("&")}` : path;
}

function browserPageUrl(): string | undefined {
  if (typeof window === "undefined" || !window.location) return undefined;
  return sanitizePageUrl(`${window.location.pathname}${window.location.search}`);
}

/**
 * Remembers the latest page view carrying a utm_* param (sanitized, 24 h expiry) so
 * visit-scoped UTM conditions still match lines added later from other pages. A later
 * UTM page view overwrites it (last UTM touch). localStorage, so it is shared across tabs.
 */
export function recordUtmLanding(
  pageUrl = rawBrowserUrl(),
  storage: Pick<Storage, "setItem"> | undefined = localStorageOrUndefined(),
  now = Date.now(),
): void {
  if (!pageUrl || !/[?&]utm_/i.test(pageUrl)) return;
  try {
    storage?.setItem(
      LANDING_STORAGE_KEY,
      JSON.stringify({ u: sanitizePageUrl(pageUrl), e: now + LANDING_TTL_MS }),
    );
  } catch {
    // Storage disabled or full: visit-scoped UTM offers just won't match.
  }
}

/**
 * The previous bundle kept the raw landing (no expiry, unsanitized) in sessionStorage under the same key.
 * Move it once into the localStorage record (fresh 24 h, sanitized) unless a valid one exists, then drop it.
 */
export function migrateLegacyLanding(
  session: Pick<Storage, "getItem" | "removeItem"> | undefined = sessionStorageOrUndefined(),
  local: Pick<Storage, "getItem" | "setItem"> | undefined = localStorageOrUndefined(),
  now = Date.now(),
): void {
  try {
    const legacy = session?.getItem(LANDING_STORAGE_KEY);
    if (legacy == null) return;
    session?.removeItem(LANDING_STORAGE_KEY);
    if (!local || legacy.startsWith("{") || !/[?&]utm_/i.test(legacy)) return;
    const current = local.getItem(LANDING_STORAGE_KEY);
    if (current) {
      const parsed = JSON.parse(current) as { e?: unknown };
      if (typeof parsed.e === "number" && parsed.e > now) return;
    }
    local.setItem(LANDING_STORAGE_KEY, JSON.stringify({ u: sanitizePageUrl(legacy), e: now + LANDING_TTL_MS }));
  } catch {
    // Storage unavailable or corrupt: nothing to migrate.
  }
}

function sessionStorageOrUndefined(): Storage | undefined {
  try {
    return typeof sessionStorage === "undefined" ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}

function rawBrowserUrl(): string | undefined {
  if (typeof window === "undefined" || !window.location) return undefined;
  return `${window.location.pathname}${window.location.search}`;
}

function browserLandingUrl(now = Date.now()): string | undefined {
  try {
    const storage = localStorageOrUndefined();
    const raw = storage?.getItem(LANDING_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { u?: unknown; e?: unknown };
    if (typeof parsed.u === "string" && typeof parsed.e === "number" && parsed.e > now) return parsed.u;
    storage?.removeItem(LANDING_STORAGE_KEY);
  } catch {
    // Unreadable or corrupt: treat as no landing.
  }
  return undefined;
}

/**
 * Packs promo properties into the single `_promo_engine_metadata` field.
 * `sourcePageUrl`/`landingUrl`: undefined = current browser state, null = never stamp
 * (updates and migrations of an existing line must not change which page it was added on).
 */
export function withPromoMetadata(
  properties: LineProperties,
  sourcePageUrl: string | null | undefined = browserPageUrl(),
  landingUrl: string | null | undefined = browserLandingUrl(),
): LineProperties {
  let enriched =
    sourcePageUrl && !properties["_promo_page_url"]
      ? { ...properties, _promo_page_url: sanitizePageUrl(sourcePageUrl) }
      : properties;
  if (landingUrl && !enriched["_promo_landing_url"]) {
    enriched = { ...enriched, _promo_landing_url: landingUrl };
  }
  const metadata = existingMetadata(enriched[METADATA_PROPERTY]);
  for (const [key, value] of Object.entries(enriched)) {
    if (key !== METADATA_PROPERTY) metadata[key] = value;
  }
  if (Object.keys(metadata).length === 0) return enriched;
  return { ...enriched, [METADATA_PROPERTY]: JSON.stringify(metadata) };
}

export function needsPromoMetadataPacking(
  properties: Record<string, unknown> | undefined,
): boolean {
  if (!properties) return false;
  const packed = existingMetadata(
    typeof properties[METADATA_PROPERTY] === "string" ? properties[METADATA_PROPERTY] : undefined,
  );
  return Object.entries(properties).some(
    ([key, value]) =>
      key !== METADATA_PROPERTY && typeof value === "string" && packed[key] !== value,
  );
}

function packJsonPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const object = payload as Record<string, unknown>;
  if (Array.isArray(object["items"])) {
    return {
      ...object,
      items: object["items"].map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return item;
        const line = item as Record<string, unknown>;
        const properties = line["properties"];
        const normalizedProperties =
          properties && typeof properties === "object" && !Array.isArray(properties)
            ? stringProperties(properties)
            : {};
        return { ...line, properties: withPromoMetadata(normalizedProperties) };
      }),
    };
  }
  const properties = object["properties"];
  const normalizedProperties =
    properties && typeof properties === "object" && !Array.isArray(properties)
      ? stringProperties(properties)
      : {};
  return { ...object, properties: withPromoMetadata(normalizedProperties) };
}

function stringProperties(value: object): LineProperties {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, candidate]) =>
      typeof candidate === "string" ||
      typeof candidate === "number" ||
      typeof candidate === "boolean"
        ? [[key, String(candidate)]]
        : [],
    ),
  );
}

const ROOT_PROP = /^properties\[([^\]]+)]$/;
const ITEM_PROP = /^items\[(\d+)]\[properties]\[([^\]]+)]$/;
const ITEM_ANY = /^items\[(\d+)]\[/;

/** Stamps flat form/urlencoded bodies: root `properties[k]`, or each `items[N][properties][k]` of a multi-item add. */
function stampFlat(entries: Array<[string, unknown]>, set: (name: string, value: string) => void): void {
  const root: LineProperties = {};
  const items = new Map<string, LineProperties>();
  for (const [name, value] of entries) {
    const itemProp = ITEM_PROP.exec(name);
    if (itemProp) {
      const bucket = items.get(itemProp[1]!) ?? {};
      if (typeof value === "string") bucket[itemProp[2]!] = value;
      items.set(itemProp[1]!, bucket);
      continue;
    }
    const itemAny = ITEM_ANY.exec(name);
    if (itemAny) {
      if (!items.has(itemAny[1]!)) items.set(itemAny[1]!, {});
      continue;
    }
    const key = ROOT_PROP.exec(name)?.[1];
    if (key && typeof value === "string") root[key] = value;
  }
  if (items.size === 0) items.set("", root);
  items.forEach((properties, index) => {
    const packed = withPromoMetadata(properties)[METADATA_PROPERTY];
    if (packed) set(index === "" ? `properties[${METADATA_PROPERTY}]` : `items[${index}][properties][${METADATA_PROPERTY}]`, packed);
  });
}

function packedFormData(body: FormData): FormData {
  const clone = new FormData();
  const entries: Array<[string, unknown]> = [];
  body.forEach((value, key) => {
    clone.append(key, value);
    entries.push([key, value]);
  });
  stampFlat(entries, (name, value) => clone.set(name, value));
  return clone;
}

function packedSearchParams(body: URLSearchParams): URLSearchParams {
  const clone = new URLSearchParams(body);
  const entries: Array<[string, unknown]> = [];
  clone.forEach((value, name) => entries.push([name, value]));
  stampFlat(entries, (name, value) => clone.set(name, value));
  return clone;
}

function packedBody(body: BodyInit | null | undefined): BodyInit | null | undefined {
  if (body instanceof FormData) return packedFormData(body);
  if (body instanceof URLSearchParams) return packedSearchParams(body);
  if (typeof body !== "string") return body;
  try {
    return JSON.stringify(packJsonPayload(JSON.parse(body)));
  } catch {
    return packedSearchParams(new URLSearchParams(body)).toString();
  }
}

function isCartAddRequest(input: RequestInfo | URL, init?: RequestInit): boolean {
  if ((init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase() !== "POST")
    return false;
  const rawUrl = input instanceof Request ? input.url : input.toString();
  try {
    const baseUrl = typeof window === "undefined" ? "https://localhost" : window.location.origin;
    return /\/cart\/add(?:\.js)?\/?$/.test(new URL(rawUrl, baseUrl).pathname);
  } catch {
    return false;
  }
}

export async function packCartAddRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<[RequestInfo | URL, RequestInit | undefined]> {
  if (!isCartAddRequest(input, init)) return [input, init];

  if (init?.body !== undefined && init.body !== null) {
    return [input, { ...init, body: packedBody(init.body) }];
  }

  if (!(input instanceof Request)) return [input, init];

  const request = new Request(input, init);
  if (!request.body) return [request, undefined];

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  let body: BodyInit;
  if (contentType.includes("multipart/form-data")) {
    body = packedFormData(await request.clone().formData());
  } else if (contentType.includes("application/x-www-form-urlencoded")) {
    body = packedSearchParams(new URLSearchParams(await request.clone().text()));
  } else {
    body = packedBody(await request.clone().text()) ?? "";
  }

  const headers = new Headers(request.headers);
  // The browser must generate a fresh multipart boundary for the cloned body.
  if (body instanceof FormData) headers.delete("content-type");
  return [new Request(request, { body, headers }), undefined];
}

type PackableBody = Document | XMLHttpRequestBodyInit | null | undefined;

/** jQuery.ajax / raw XHR adds never touch fetch, so stamp them at XMLHttpRequest.send. */
export function packXhrBody(body: PackableBody): PackableBody {
  if (typeof body === "string") return packedBody(body) as string;
  if (typeof FormData !== "undefined" && body instanceof FormData) return packedFormData(body);
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return packedSearchParams(body);
  return body;
}

function patchXhrCartAdd(): void {
  if (typeof XMLHttpRequest === "undefined") return;
  const proto = XMLHttpRequest.prototype;
  const originalOpen = proto.open;
  const originalSend = proto.send;
  const cartAdds = new WeakSet<XMLHttpRequest>();

  proto.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    if (isCartAddRequest(String(url), { method: String(method) })) cartAdds.add(this);
    else cartAdds.delete(this);
    return (originalOpen as (...args: unknown[]) => void).apply(this, [method, url, ...rest]);
  } as typeof proto.open;

  proto.send = function (this: XMLHttpRequest, body?: PackableBody) {
    let outgoing = body;
    if (cartAdds.has(this)) {
      try {
        outgoing = packXhrBody(body);
      } catch (e) {
        console.warn("[PromoEngine] Cart line metadata packing failed, using request as-is", e);
      }
    }
    return (originalSend as (b?: PackableBody) => void).call(this, outgoing);
  } as typeof proto.send;
}

interface CartLineLike {
  key: string;
  quantity?: number;
  properties?: Record<string, unknown> | null;
  selling_plan_allocation?: { selling_plan?: { id?: number | string } } | null;
}

interface CartLike {
  items?: CartLineLike[];
}

export interface LateStamperDeps {
  getCart: () => Promise<CartLike | null>;
  changeLine: (change: Record<string, unknown>) => Promise<CartLike | null>;
  pageUrl: () => string | undefined;
}

/**
 * Safety net for adds that bypass the fetch/XHR/submit patches (a script that cached `window.fetch`
 * before this bundle ran, a native `form.submit()`, a theme using its own transport): lines that
 * appear in the cart during this page view with no `_promo_engine_metadata` at all are stamped with
 * the current page through /cart/change.js. Lines present when the page loaded, and lines that
 * already carry metadata (a deliberate null page, our own gift lines), are never touched.
 */
export function createLateStamper(deps: LateStamperDeps): {
  baseline: () => Promise<void>;
  assumeEmpty: () => void;
  check: () => Promise<number>;
} {
  let known: Set<string> | null = null;
  const remember = (cart: CartLike | null) => {
    known = new Set((cart?.items ?? []).map((line) => line.key));
  };
  return {
    async baseline() {
      remember(await deps.getCart());
    },
    assumeEmpty() {
      known = new Set();
    },
    async check() {
      const cart = await deps.getCart();
      if (!cart) return 0;
      const before = known;
      if (!before) {
        remember(cart);
        return 0;
      }
      const page = deps.pageUrl();
      let stamped = 0;
      let latest: CartLike = cart;
      for (const line of cart.items ?? []) {
        if (before.has(line.key) || !page) continue;
        const properties = stringProperties(line.properties ?? {});
        if (METADATA_PROPERTY in properties) continue;
        const planId = line.selling_plan_allocation?.selling_plan?.id;
        const next = await deps.changeLine({
          id: line.key,
          quantity: line.quantity ?? 1,
          properties: withPromoMetadata(properties, page),
          ...(planId !== undefined ? { selling_plan: planId } : {}),
        });
        if (next) {
          latest = next;
          stamped += 1;
        }
      }
      remember(latest);
      return stamped;
    },
  };
}

const CART_MUTATION_PATH = /\/cart\/(?:add|update|change|clear)(?:\.js)?\/?$/;

function installLateStamper(nativeFetch: typeof window.fetch): void {
  if (typeof PerformanceObserver === "undefined") return;
  const json = (response: Response) => (response.ok ? (response.json() as Promise<CartLike>) : Promise.resolve(null));
  const stamper = createLateStamper({
    getCart: () =>
      nativeFetch("/cart.js", { credentials: "same-origin", headers: { Accept: "application/json" } })
        .then(json)
        .catch(() => null),
    changeLine: (change) =>
      nativeFetch("/cart/change.js", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(change),
      })
        .then(json)
        .catch(() => null),
    pageUrl: browserPageUrl,
  });
  // The embed renders the cart count, so an empty cart needs no baseline request.
  const emptyCart = window.__promoEngineConfig?.cartItemCount === 0;
  if (emptyCart) stamper.assumeEmpty();
  const ready = emptyCart ? Promise.resolve() : stamper.baseline().catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let rerun = false;
  const run = () => {
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    void ready
      .then(() => stamper.check())
      .catch(() => 0)
      .then(() => {
        running = false;
        if (rerun) {
          rerun = false;
          schedule();
        }
      });
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, 400);
  };
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        try {
          if (CART_MUTATION_PATH.test(new URL(entry.name, window.location.origin).pathname)) {
            schedule();
            return;
          }
        } catch {
          // Unparseable resource name: not a cart request.
        }
      }
    }).observe({ entryTypes: ["resource"] });
  } catch {
    // Resource timing unavailable: the fetch/XHR/submit patches still apply.
  }
}

function stampFormInPlace(form: HTMLFormElement): void {
  const entries: Array<[string, unknown]> = [];
  new FormData(form).forEach((value, name) => entries.push([name, value]));
  stampFlat(entries, (name, value) => {
    let input = Array.from(form.querySelectorAll<HTMLInputElement>("input")).find((el) => el.name === name);
    if (!input) {
      input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      form.append(input);
    }
    input.value = value;
  });
}

export function installPromoMetadataBridge(): void {
  const state = window as Window & { __promoEngineMetadataBridgeInstalled?: boolean };
  if (state.__promoEngineMetadataBridgeInstalled) return;
  state.__promoEngineMetadataBridgeInstalled = true;
  migrateLegacyLanding();
  recordUtmLanding();

  const nativeFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    // Only the packing step is guarded — never retry the network call itself,
    // that would double-submit a POST /cart/add on failure.
    return packCartAddRequest(input, init)
      .catch((e): [RequestInfo | URL, RequestInit | undefined] => {
        console.warn("[PromoEngine] Cart line metadata packing failed, using request as-is", e);
        return [input, init];
      })
      .then(([packedInput, packedInit]) => nativeFetch(packedInput, packedInit));
  }) as typeof window.fetch;

  patchXhrCartAdd();

  document.addEventListener(
    "submit",
    (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement) || !isCartAddRequest(form.action, { method: form.method })) return;
      stampFormInPlace(form);
    },
    true,
  );

  // form.submit() never fires a submit event, so a theme or app posting the add form that way was unstamped.
  if (typeof HTMLFormElement !== "undefined") {
    const originalSubmit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function (this: HTMLFormElement) {
      try {
        if (isCartAddRequest(this.action, { method: this.method })) stampFormInPlace(this);
      } catch (e) {
        console.warn("[PromoEngine] Cart line metadata packing failed, using request as-is", e);
      }
      return originalSubmit.call(this);
    };
  }

  installLateStamper(nativeFetch);
}

if (typeof window !== "undefined" && typeof document !== "undefined") installPromoMetadataBridge();
