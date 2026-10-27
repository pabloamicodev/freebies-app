import { shopifyGraphQL } from "./shopify-fetch.server.js";
import {
  DIRECTORY_KEY,
  DIRECTORY_NAMESPACE,
  experimentStaleness,
  parseExperimentDirectory,
  type ExperimentDirectory,
} from "./experiment-directory.js";

export interface ExperimentDirectoryAuth {
  shopDomain: string;
  accessToken: string;
}

const QUERY = `query PromoEngineExperimentDirectory($namespace: String!, $key: String!) {
  shop { metafield(namespace: $namespace, key: $key) { value } }
}`;

interface DirectoryData {
  shop: { metafield: { value: string } | null };
}

/** Reads the shop's metafield; any read or parse failure is `{ unavailable: true }` (manual entry still works). */
export async function getExperimentDirectory(auth: ExperimentDirectoryAuth): Promise<ExperimentDirectory> {
  try {
    const data = await shopifyGraphQL<DirectoryData>({
      ...auth,
      query: QUERY,
      variables: { namespace: DIRECTORY_NAMESPACE, key: DIRECTORY_KEY },
    });
    return parseExperimentDirectory(data.shop.metafield?.value);
  } catch {
    return { unavailable: true };
  }
}

export interface StoredExperiment {
  experimentId: string;
  variantKeys: string[];
  experimentName?: string;
}

/** Problems with stored experiment conditions; empty when they match or the directory is unreadable. */
export async function getExperimentWarnings(auth: ExperimentDirectoryAuth, conditions: StoredExperiment[]): Promise<string[]> {
  if (conditions.length === 0) return [];
  const directory = await getExperimentDirectory(auth);
  const out: string[] = [];
  for (const c of conditions) {
    const stale = experimentStaleness(c.experimentId, c.variantKeys, directory);
    const name = c.experimentName || c.experimentId;
    if (stale?.experimentMissing) out.push(`Experiment "${name}" is not in your Experiment Engine directory.`);
    else if (stale && stale.missingArms.length) out.push(`Experiment "${name}" has no arm ${stale.missingArms.map((k) => `"${k}"`).join(", ")}.`);
  }
  return out;
}
