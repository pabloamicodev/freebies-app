import { pgTable, pgEnum, uuid, text, timestamp, index } from "drizzle-orm/pg-core";

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
