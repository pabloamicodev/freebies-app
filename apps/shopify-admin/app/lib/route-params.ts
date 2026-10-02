const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** Returns the route param when it is a UUID, otherwise throws a 404 so a malformed id never reaches Postgres (uuid cast = 500). */
export function parseUuidParam(params: Readonly<Record<string, string | undefined>>, name = "id"): string {
  const value = params[name];
  if (!isUuid(value)) throw new Response("Not found", { status: 404 });
  return value;
}
