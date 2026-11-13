import { and, eq } from "drizzle-orm";
import { appSettings, type Db } from "@promo/db";
import { SUPPORTED_LOCALES, WidgetTranslationsSchema, type WidgetTranslations } from "@promo/shared-types";
import { parseStoredJson } from "./offer-validation.server.js";
import { MAX_TRANSLATION_LENGTH, TRANSLATION_KEYS } from "./translation-keys.js";
import { placeholderError } from "./translation-placeholders.js";
import { insertAuditLog } from "./audit-log.server.js";
import type { AuthoringResult } from "./offer-authoring/types.js";

export const TRANSLATIONS_SETTING_KEY = "translations.strings";

export type TranslationsByLocale = Record<string, Partial<WidgetTranslations>>;
type StringMap = Partial<Record<keyof WidgetTranslations, string>>;

export async function loadTranslations(db: Db, shopId: string): Promise<TranslationsByLocale> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, TRANSLATIONS_SETTING_KEY)))
    .limit(1);
  if (!row) return {};
  const parsed = parseStoredJson(row.value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as TranslationsByLocale) : {};
}

export type TranslationKeyInfo = {
  key: string;
  label: string;
  hint: string | null;
  allowedVars: string[];
  defaultValue: string | null;
  value: string | null;
};

/** Every editable key with its label, hint, allowed `{{vars}}`, English default and the stored value for `locale`. */
export async function getTranslations(db: Db, shopId: string, locale: string) {
  const all = await loadTranslations(db, shopId);
  const defaults = WidgetTranslationsSchema.parse({ locale: "en" }) as Record<string, unknown>;
  const stored = (all[locale] ?? {}) as Record<string, unknown>;
  const keys: TranslationKeyInfo[] = TRANSLATION_KEYS.map(({ key, label, hint, vars }) => ({
    key,
    label,
    hint: hint ?? null,
    allowedVars: [...(vars ?? [])],
    defaultValue: typeof defaults[key] === "string" ? (defaults[key] as string) : null,
    value: typeof stored[key] === "string" ? (stored[key] as string) : null,
  }));
  return { locale, keys, localesWithStrings: Object.keys(all).filter((l) => Object.keys(all[l] ?? {}).some((k) => k !== "locale")) };
}

export type SetTranslationsInput = {
  locale: string;
  /** key -> text. `replace`: the locale's strings become exactly these (blank entries dropped). `patch`: merged into the stored strings; null or blank removes a key. */
  strings: Record<string, string | null | undefined>;
  mode: "replace" | "patch";
};

export type SetTranslationsResult = { locale: string; strings: StringMap; changedKeys: string[]; written: boolean };

export async function setTranslations(
  deps: { db: Db; shopId: string },
  input: SetTranslationsInput,
  opts: { dryRun?: boolean; performedBy?: string; auditExtra?: Record<string, unknown> } = {},
): Promise<AuthoringResult<SetTranslationsResult>> {
  const { locale } = input;
  if (!(SUPPORTED_LOCALES as readonly string[]).includes(locale)) return { ok: false, error: "Choose a supported language." };
  const known = new Set<string>(TRANSLATION_KEYS.map((k) => k.key));
  const unknown = Object.keys(input.strings).find((k) => !known.has(k));
  if (unknown) return { ok: false, error: `Unknown translation key "${unknown}".`, path: unknown };

  const all = await loadTranslations(deps.db, deps.shopId);
  const base: StringMap = input.mode === "patch" ? { ...((all[locale] ?? {}) as StringMap) } : {};
  const strings: StringMap = { ...base };
  for (const { key, label, vars } of TRANSLATION_KEYS) {
    if (!(key in input.strings)) continue;
    const raw = input.strings[key];
    const val = typeof raw === "string" ? raw.trim() : "";
    if (!val) {
      delete strings[key];
      continue;
    }
    if (val.length > MAX_TRANSLATION_LENGTH) return { ok: false, error: `${label}: keep it under ${MAX_TRANSLATION_LENGTH} characters.`, path: key };
    const problem = placeholderError(label, val, vars ?? []);
    if (problem) return { ok: false, error: problem, path: key };
    strings[key] = val;
  }
  const next = { ...strings, locale } as Partial<WidgetTranslations>;
  const before = (all[locale] ?? {}) as Record<string, unknown>;
  const changedKeys = TRANSLATION_KEYS.map((k) => k.key as string).filter((k) => before[k] !== (strings as Record<string, unknown>)[k]);
  if (!opts.dryRun) {
    const merged = { ...all, [locale]: next };
    await deps.db
      .insert(appSettings)
      .values({ shopId: deps.shopId, key: TRANSLATIONS_SETTING_KEY, value: JSON.stringify(merged) })
      .onConflictDoUpdate({
        target: [appSettings.shopId, appSettings.key],
        set: { value: JSON.stringify(merged), updatedAt: new Date() },
      });
    if (opts.performedBy) {
      await insertAuditLog(deps.db, { shopId: deps.shopId, entityType: "shop", entityId: deps.shopId, action: "translations_update", before, after: { locale, ...strings, ...opts.auditExtra }, performedBy: opts.performedBy });
    }
  }
  return { ok: true, value: { locale, strings, changedKeys, written: !opts.dryRun } };
}
