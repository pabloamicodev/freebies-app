const METADATA_PROPERTY = "_promo_engine_metadata";

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
  for (const [key, value] of Object.entries(properties)) {
    if (key !== METADATA_PROPERTY) metadata[key] = value;
  }
  if (Object.keys(metadata).length === 0) return properties;
  return { ...properties, [METADATA_PROPERTY]: JSON.stringify(metadata) };
}

export function needsPromoMetadataPacking(
  properties: Record<string, unknown> | undefined,
): boolean {
  if (!properties) return false;
  const packed = existingMetadata(
    typeof properties[METADATA_PROPERTY] === "string"
      ? properties[METADATA_PROPERTY]
      : undefined,
  );
  return Object.entries(properties).some(([key, value]) =>
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

function installPromoMetadataBridge(): void {
  const state = window as Window & { __promoEngineMetadataBridgeInstalled?: boolean };
  if (state.__promoEngineMetadataBridgeInstalled) return;
  state.__promoEngineMetadataBridgeInstalled = true;

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const [packedInput, packedInit] = await packCartAddRequest(input, init);
    return nativeFetch(packedInput, packedInit);
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
