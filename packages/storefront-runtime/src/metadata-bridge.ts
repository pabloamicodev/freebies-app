const METADATA_PROPERTY = "_promo_engine_metadata";

const PACKED_PROPERTY_KEYS = [
  "_promo_engine_line_type",
  "_promo_engine_offer_id",
  "_promo_engine_reward_id",
  "_promo_engine_offer_version",
  "_bundle_item",
  "_nektar_glp1",
  "__landing_source",
  "__bundle_type",
  "__cart_gift_tier",
  "_quiz_bundle_id",
  "_quiz_target_cents",
  "_quiz_expected_paid_count",
  "_quiz_free_gift",
] as const;

type LineProperties = Record<string, string>;

function existingMetadata(value: string | undefined): LineProperties {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

export function withPromoMetadata(properties: LineProperties): LineProperties {
  const metadata = existingMetadata(properties[METADATA_PROPERTY]);
  for (const key of PACKED_PROPERTY_KEYS) {
    const value = properties[key];
    if (typeof value === "string") metadata[key] = value;
  }
  if (Object.keys(metadata).length === 0) return properties;
  return { ...properties, [METADATA_PROPERTY]: JSON.stringify(metadata) };
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
        if (!properties || typeof properties !== "object" || Array.isArray(properties)) return item;
        return { ...line, properties: withPromoMetadata(stringProperties(properties)) };
      }),
    };
  }
  const properties = object["properties"];
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return payload;
  return { ...object, properties: withPromoMetadata(stringProperties(properties)) };
}

function stringProperties(value: object): LineProperties {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, candidate]) =>
      typeof candidate === "string" || typeof candidate === "number" || typeof candidate === "boolean"
        ? [[key, String(candidate)]]
        : [],
    ),
  );
}

function packedFormData(body: FormData): FormData {
  const clone = new FormData();
  body.forEach((value, key) => clone.append(key, value));
  const properties: LineProperties = {};
  clone.forEach((value, name) => {
    const match = /^properties\[([^\]]+)]$/.exec(name);
    const key = match?.[1];
    if (key && typeof value === "string") properties[key] = value;
  });
  const packed = withPromoMetadata(properties)[METADATA_PROPERTY];
  if (packed) clone.set(`properties[${METADATA_PROPERTY}]`, packed);
  return clone;
}

function packedSearchParams(body: URLSearchParams): URLSearchParams {
  const clone = new URLSearchParams(body);
  const properties: LineProperties = {};
  clone.forEach((value, name) => {
    const key = /^properties\[([^\]]+)]$/.exec(name)?.[1];
    if (key) properties[key] = value;
  });
  const packed = withPromoMetadata(properties)[METADATA_PROPERTY];
  if (packed) clone.set(`properties[${METADATA_PROPERTY}]`, packed);
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
  if ((init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase() !== "POST") return false;
  const rawUrl = input instanceof Request ? input.url : input.toString();
  try {
    return /\/cart\/add(?:\.js)?\/?$/.test(new URL(rawUrl, window.location.origin).pathname);
  } catch {
    return false;
  }
}

function installPromoMetadataBridge(): void {
  const state = window as Window & { __promoEngineMetadataBridgeInstalled?: boolean };
  if (state.__promoEngineMetadataBridgeInstalled) return;
  state.__promoEngineMetadataBridgeInstalled = true;

  const nativeFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (!isCartAddRequest(input, init) || !init) return nativeFetch(input, init);
    return nativeFetch(input, { ...init, body: packedBody(init.body) });
  }) as typeof window.fetch;

  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !isCartAddRequest(form.action, { method: form.method })) return;
    const properties: LineProperties = {};
    new FormData(form).forEach((value, name) => {
      const match = /^properties\[([^\]]+)]$/.exec(name);
      const key = match?.[1];
      if (key && typeof value === "string") properties[key] = value;
    });
    const packed = withPromoMetadata(properties)[METADATA_PROPERTY];
    if (!packed) return;
    let input = form.querySelector<HTMLInputElement>(`input[name="properties[${METADATA_PROPERTY}]"]`);
    if (!input) {
      input = document.createElement("input");
      input.type = "hidden";
      input.name = `properties[${METADATA_PROPERTY}]`;
      form.append(input);
    }
    input.value = packed;
  }, true);
}

if (typeof window !== "undefined" && typeof document !== "undefined") installPromoMetadataBridge();
