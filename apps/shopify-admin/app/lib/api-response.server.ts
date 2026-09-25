import { waitUntil } from "@vercel/functions";
import * as Sentry from "@sentry/node";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const requestIds = new WeakMap<Request, string>();

export interface ApiErrorOptions {
  status: number;
  code: string;
  message: string;
  retryable?: boolean;
  retryAfterSeconds?: number;
  details?: unknown;
  headers?: HeadersInit;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  readonly details?: unknown;
  readonly headers?: HeadersInit;

  constructor(options: ApiErrorOptions) {
    super(options.message);
    this.name = "ApiError";
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.details = options.details;
    this.headers = options.headers;
  }
}

export function getRequestId(request: Request): string {
  const existing = requestIds.get(request);
  if (existing) return existing;
  const incoming = request.headers.get("x-request-id")?.trim();
  const requestId = incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : crypto.randomUUID();
  requestIds.set(request, requestId);
  return requestId;
}

export function apiJson(
  request: Request,
  data: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("X-Request-Id", getRequestId(request));
  headers.set("Cache-Control", headers.get("Cache-Control") ?? "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return Response.json(data, { ...init, headers });
}

export function apiError(request: Request, options: ApiErrorOptions): Response {
  const requestId = getRequestId(request);
  const headers = new Headers(options.headers);
  headers.set("X-Request-Id", requestId);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  if (options.retryAfterSeconds !== undefined) {
    headers.set("Retry-After", String(options.retryAfterSeconds));
  }

  return Response.json(
    {
      ok: false,
      // Keep the string field for existing clients while exposing a stable,
      // machine-readable code and correlation id.
      error: options.message,
      code: options.code,
      requestId,
      retryable: options.retryable ?? false,
      ...(options.details === undefined ? {} : { details: options.details }),
    },
    { status: options.status, headers },
  );
}

export function handleApiError(
  request: Request,
  error: unknown,
  context: string,
): Response {
  if (error instanceof Response) return error;
  if (error instanceof ApiError) {
    return apiError(request, {
      status: error.status,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      retryAfterSeconds: error.retryAfterSeconds,
      details: error.details,
      headers: error.headers,
    });
  }

  const requestId = getRequestId(request);
  Sentry.captureException(error, { tags: { route: context, requestId } });
  waitUntil(Sentry.flush(2000));
  console.error(`[${context}] request failed`, {
    requestId,
    error: error instanceof Error
      ? { name: error.name, message: error.message, code: errorCode(error) }
      : { name: "UnknownError", message: String(error) },
  });

  return apiError(request, {
    status: 500,
    code: "INTERNAL_ERROR",
    message: "The request could not be completed. Retry or contact support with the requestId.",
    retryable: true,
    headers: { "X-Request-Id": requestId },
  });
}

export async function readJsonBody<T>(
  request: Request,
  options: { maxBytes: number; tooLargeMessage?: string; invalidMessage?: string },
): Promise<T> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
    throw new ApiError({
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
      message: options.tooLargeMessage ?? "Request payload is too large.",
    });
  }

  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > options.maxBytes) {
    throw new ApiError({
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
      message: options.tooLargeMessage ?? "Request payload is too large.",
    });
  }

  try {
    return JSON.parse(rawBody) as T;
  } catch {
    throw new ApiError({
      status: 400,
      code: "INVALID_JSON",
      message: options.invalidMessage ?? "Request body must be valid JSON.",
    });
  }
}

function errorCode(error: Error): string | undefined {
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
