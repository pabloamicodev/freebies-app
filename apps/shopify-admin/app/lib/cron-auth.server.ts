import { timingSafeEqual } from "node:crypto";

export function isCronRequestAuthorized(request: Request): boolean {
  const expected = process.env["CRON_SECRET"];
  if (!expected) return false;

  const authorization = request.headers.get("authorization");
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
  const provided = bearer ?? request.headers.get("x-vercel-cron-secret");
  return provided !== null && safeEqual(provided, expected);
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
