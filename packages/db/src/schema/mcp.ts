import { pgTable, pgEnum, uuid, text, timestamp, index, integer, jsonb, uniqueIndex } from "drizzle-orm/pg-core";

export const mcpRoleEnum = pgEnum("mcp_role", ["viewer", "editor", "admin"]);
export const mcpCredentialKindEnum = pgEnum("mcp_credential_kind", ["pat", "access", "refresh"]);

export const mcpOperators = pgTable("mcp_operators", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  role: mcpRoleEnum("role").notNull().default("viewer"),
  /** myshopify domains this operator may see; empty = every shop. */
  shopAllowList: text("shop_allow_list").array().notNull().default([]),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const mcpCredentials = pgTable(
  "mcp_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => mcpOperators.id, { onDelete: "cascade" }),
    kind: mcpCredentialKindEnum("kind").notNull(),
    /** sha256(pepper + token) hex; the token itself is never stored. */
    tokenHash: text("token_hash").notNull().unique(),
    prefix: text("prefix").notNull(),
    familyId: uuid("family_id"),
    clientId: text("client_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("mcp_credentials_operator_id_idx").on(t.operatorId)],
);

export type McpOperator = typeof mcpOperators.$inferSelect;
export type McpCredential = typeof mcpCredentials.$inferSelect;

/**
 * One row per MCP tool call (reads too). A write that executes claims its row BEFORE running
 * (`confirm_jti` unique = single-use confirm token, `idempotency_key` unique per operator+tool = replay
 * guard) and fills `outcome` / `result_ref` after. Args are redacted before they get here.
 */
export const mcpCallLog = pgTable(
  "mcp_call_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id").references(() => mcpOperators.id, { onDelete: "set null" }),
    tool: text("tool").notNull(),
    shops: text("shops").array().notNull().default([]),
    argsRedacted: jsonb("args_redacted"),
    /** "pending" while a write runs, then "ok" or the ErrorCode. */
    outcome: text("outcome").notNull(),
    durationMs: integer("duration_ms"),
    idempotencyKey: text("idempotency_key"),
    confirmJti: text("confirm_jti").unique(),
    /** The stored ToolResult of an executed write, replayed for 24 h on the same idempotency key. */
    resultRef: jsonb("result_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("mcp_call_log_operator_created_idx").on(t.operatorId, t.createdAt),
    index("mcp_call_log_created_idx").on(t.createdAt),
    uniqueIndex("mcp_call_log_idempotency_idx").on(t.operatorId, t.tool, t.idempotencyKey),
  ],
);

export type McpCallLog = typeof mcpCallLog.$inferSelect;
