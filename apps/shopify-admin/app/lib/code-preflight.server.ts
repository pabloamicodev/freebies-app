/**
 * Collision handling between our own discount codes and the merchant's other
 * Shopify discounts. Hard rule: this module only ever READS other discounts. A
 * colliding code of ours is renamed on OUR side (regenerated, or published as a
 * suffixed variant); a discount the merchant created is never modified.
 */
import { and, eq } from "drizzle-orm";
import { discountCodes, getDb, type DiscountCode } from "@promo/db";
import { shopifyGraphQL } from "./shopify-fetch.server.js";
import { insertAuditLog } from "./audit-log.server.js";
import { randomCode, type CodeCharset } from "./discount-code-generation.js";
import { codeHash } from "./code-hash.js";
import { isConstraintViolation } from "./unique-offer-name.server.js";
import { chunk } from "./discount-node.server.js";

export type CodeAvailability =
  | { status: "free" }
  | { status: "ours" }
  | { status: "taken"; title: string | null };

const LOOKUP_BATCH = 40;
const SUFFIX_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_RESOLUTION_ROUNDS = 8;

interface LookupNode {
  id: string;
  codeDiscount: { title?: string | null } | null;
}

/** Looks codes up in Shopify (batched with aliases). `ownNodeId` marks codes already on our node. */
export async function lookupCodes(
  shopDomain: string,
  accessToken: string,
  codes: string[],
  ownNodeId: string | null,
): Promise<Map<string, CodeAvailability>> {
  const result = new Map<string, CodeAvailability>();
  for (const group of chunk([...new Set(codes)], LOOKUP_BATCH)) {
    const variableDefs = group.map((_, i) => `$c${i}: String!`).join(", ");
    const fields = group
      .map(
        (_, i) => `c${i}: codeDiscountNodeByCode(code: $c${i}) {
          id
          codeDiscount {
            ... on DiscountCodeBasic { title }
            ... on DiscountCodeBxgy { title }
            ... on DiscountCodeFreeShipping { title }
            ... on DiscountCodeApp { title }
          }
        }`,
      )
      .join("\n");
    const data = await shopifyGraphQL<Record<string, LookupNode | null>>({
      shopDomain,
      accessToken,
      query: `query PromoEngineCodeLookup(${variableDefs}) {\n${fields}\n}`,
      variables: Object.fromEntries(group.map((code, i) => [`c${i}`, code])),
    });
    group.forEach((code, i) => {
      const node = data[`c${i}`];
      if (!node) result.set(code, { status: "free" });
      else if (ownNodeId && node.id === ownNodeId) result.set(code, { status: "ours" });
      else result.set(code, { status: "taken", title: node.codeDiscount?.title ?? null });
    });
  }
  return result;
}

/** Deterministic, readable suffixed variant: PRIME -> PRIME-7Q4 (attempt changes the suffix). */
export function suffixedCode(base: string, seed: string, attempt: number): string {
  let value = parseInt(codeHash(`${seed}:${base}:${attempt}`).slice(0, 8), 16);
  let suffix = "";
  for (let i = 0; i < 3; i += 1) {
    suffix += SUFFIX_ALPHABET[value % SUFFIX_ALPHABET.length];
    value = Math.floor(value / SUFFIX_ALPHABET.length);
  }
  return `${base.slice(0, 250)}-${suffix}`;
}

async function updateCode(row: DiscountCode, values: Partial<DiscountCode>): Promise<boolean> {
  try {
    await getDb()
      .update(discountCodes)
      .set({ ...values, shopifySyncedAt: null, updatedAt: new Date() })
      .where(and(eq(discountCodes.shopId, row.shopId), eq(discountCodes.id, row.id)));
    return true;
  } catch (err) {
    if (isConstraintViolation(err, "discount_codes_shop_code_idx")) return false;
    throw err;
  }
}

export interface CollisionContext {
  shopDomain: string;
  accessToken: string;
  /** The offer's own code node, so codes already on it are recognised as ours. */
  ownNodeId: string | null;
  offerName: string;
}

/**
 * Makes every given row's `code` free in Shopify. Rows whose code is on our own
 * node or free are untouched. A colliding generated code (row has a batch) is
 * replaced by a fresh random one of the same shape; a colliding chosen code is
 * published as a suffixed variant, keeping the original in `requestedCode` and
 * the other discount's title in `collisionNote`. Rows are mutated in place.
 * Never throws because of a collision; returns what changed.
 */
export async function resolveCodeCollisions(
  rows: DiscountCode[],
  context: CollisionContext,
  batchShape: (
    row: DiscountCode,
  ) => { prefix: string; length: number; charset: CodeCharset } | null = () => null,
): Promise<{ regenerated: number; suffixed: DiscountCode[]; alreadyOurs: DiscountCode[] }> {
  let pending = rows;
  let regenerated = 0;
  const suffixed: DiscountCode[] = [];
  const alreadyOurs: DiscountCode[] = [];
  const attempts = new Map<string, number>();

  for (let round = 0; round < MAX_RESOLUTION_ROUNDS && pending.length > 0; round += 1) {
    const availability = await lookupCodes(
      context.shopDomain,
      context.accessToken,
      pending.map((row) => row.code),
      context.ownNodeId,
    );
    const stillColliding: DiscountCode[] = [];
    for (const row of pending) {
      const found = availability.get(row.code) ?? { status: "free" as const };
      if (found.status === "ours" && !alreadyOurs.includes(row)) alreadyOurs.push(row);
      if (found.status !== "taken") continue;
      const attempt = (attempts.get(row.id) ?? 0) + 1;
      attempts.set(row.id, attempt);
      const shape = row.batchId ? batchShape(row) : null;
      let nextCode: string;
      if (shape) {
        nextCode = randomCode(shape);
        regenerated += 1;
        console.info(`[code-preflight] Generated code ${row.code} exists in Shopify; regenerated.`);
        if (!(await updateCode(row, { code: nextCode }))) {
          stillColliding.push(row);
          continue;
        }
        row.code = nextCode;
      } else {
        const base = row.requestedCode ?? row.code;
        nextCode = suffixedCode(base, `${row.shopId}:${row.offerId}`, attempt);
        const note = found.title ?? row.collisionNote ?? null;
        if (
          !(await updateCode(row, { code: nextCode, requestedCode: base, collisionNote: note }))
        ) {
          stillColliding.push(row);
          continue;
        }
        row.code = nextCode;
        row.requestedCode = base;
        row.collisionNote = note;
        if (!suffixed.includes(row)) suffixed.push(row);
      }
      row.shopifySyncedAt = null;
      stillColliding.push(row); // re-check the replacement against Shopify next round
    }
    pending = stillColliding;
  }

  for (const row of suffixed) {
    await insertAuditLog(getDb(), {
      shopId: row.shopId,
      entityType: "offer",
      entityId: row.offerId,
      action: "code_collision_resolved",
      before: { code: row.requestedCode },
      after: { code: row.code, existingDiscount: row.collisionNote },
      performedBy: "system",
    });
  }
  return { regenerated, suffixed, alreadyOurs };
}
