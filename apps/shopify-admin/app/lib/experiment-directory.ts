/**
 * Client-safe half of the experiment directory: the shop metafield `experiment_engine.directory`
 * written by the Experiment Engine app. It is advisory (picker labels and publish warnings); anything
 * another app wrote there is zod-parsed and filtered to the same charsets the condition accepts.
 */

import { z } from "zod";
import { ExperimentIdSchema, VariantKeySchema } from "@promo/shared-types";

export const DIRECTORY_NAMESPACE = "experiment_engine";
export const DIRECTORY_KEY = "directory";
export const DIRECTORY_MAX_EXPERIMENTS = 50;
export const DIRECTORY_MAX_BYTES = 16 * 1024;

export type DirectoryMode = "inline" | "redirect" | "in_place";

export interface DirectoryVariant {
  key: string;
  name: string;
  control: boolean;
}

export interface DirectoryExperiment {
  id: string;
  name: string;
  status: string;
  mode: DirectoryMode;
  variants: DirectoryVariant[];
}

export type ExperimentDirectory = { unavailable?: false; experiments: DirectoryExperiment[] } | { unavailable: true };

const cleanLabel = (s: string, max: number) =>
  [...s]
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 || ch === "<" || ch === ">" ? " " : ch))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
const label = (max: number) => z.string().transform((s) => cleanLabel(s, max));

const VariantSchema = z.object({
  key: VariantKeySchema,
  name: label(120).optional(),
  control: z.boolean().optional(),
});

const ExperimentSchema = z.object({
  id: ExperimentIdSchema,
  name: label(120).optional(),
  status: label(20).optional(),
  mode: z.enum(["inline", "redirect", "in_place"]).optional(),
  variants: z.array(z.unknown()).max(10),
});

const EnvelopeSchema = z.object({ v: z.literal(1), experiments: z.array(z.unknown()) });

/** Absent, oversize, malformed or version-mismatched input is `{ unavailable: true }`; bad entries are dropped. */
export function parseExperimentDirectory(raw: string | null | undefined): ExperimentDirectory {
  if (!raw || new TextEncoder().encode(raw).length > DIRECTORY_MAX_BYTES) return { unavailable: true };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { unavailable: true };
  }
  const envelope = EnvelopeSchema.safeParse(json);
  if (!envelope.success) return { unavailable: true };
  const experiments: DirectoryExperiment[] = [];
  const seen = new Set<string>();
  for (const entry of envelope.data.experiments.slice(0, DIRECTORY_MAX_EXPERIMENTS)) {
    const e = ExperimentSchema.safeParse(entry);
    if (!e.success || seen.has(e.data.id)) continue;
    const variants: DirectoryVariant[] = [];
    for (const v of e.data.variants) {
      const parsed = VariantSchema.safeParse(v);
      if (parsed.success) {
        variants.push({ key: parsed.data.key, name: parsed.data.name || parsed.data.key, control: parsed.data.control === true });
      }
    }
    seen.add(e.data.id);
    experiments.push({
      id: e.data.id,
      name: e.data.name || e.data.id,
      status: e.data.status || "",
      mode: e.data.mode ?? "in_place",
      variants,
    });
  }
  return { experiments };
}

export const MODE_LABELS: Record<DirectoryMode, string> = {
  inline: "Seamless swap",
  redirect: "Redirect",
  in_place: "In place",
};

export const STALE_EXPERIMENT_MESSAGE =
  "This experiment is no longer in your Experiment Engine directory (it may have ended or been deleted). Reselect it.";
export const STALE_ARM_MESSAGE = "Some selected arms no longer exist in this experiment. Reselect them.";

export interface ExperimentStaleness {
  experimentMissing: boolean;
  missingArms: string[];
}

/** `null` when there is no directory to compare against, so nothing is flagged. */
export function experimentStaleness(
  experimentId: string,
  variantKeys: string[],
  directory: ExperimentDirectory | null | undefined,
): ExperimentStaleness | null {
  if (!experimentId || !directory || directory.unavailable) return null;
  const experiment = directory.experiments.find((e) => e.id === experimentId);
  if (!experiment) return { experimentMissing: true, missingArms: [] };
  const known = new Set(experiment.variants.map((v) => v.key));
  return { experimentMissing: false, missingArms: variantKeys.filter((k) => !known.has(k)) };
}
