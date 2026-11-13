/**
 * Is the Promo Engine app embed enabled in a theme? The installation page (published theme only) and the MCP
 * `theme_installation_status` tool (any theme role) share the query and the verdict.
 */
import { detectPromoEngineEmbedStatus } from "./theme-app-embed.server.js";

export type EmbedVerdict = "enabled" | "disabled" | "unknown";

export interface ThemeNode {
  id: string;
  name: string;
  role?: string;
  files?: { nodes?: { body?: { content?: string } }[] };
}

export interface ThemeQueryResult {
  data?: { themes?: { nodes?: ThemeNode[] } };
  errors?: Array<{ message?: string }>;
}

/** Runs a Shopify Admin GraphQL query and returns the parsed JSON body (`{ data, errors }`). */
export type ThemeQueryRunner = (query: string) => Promise<ThemeQueryResult>;

export function themeEmbedQuery(roles: readonly string[], first: number): string {
  return `
      query CheckAppEmbed {
        themes(first: ${first}, roles: [${roles.join(", ")}]) {
          nodes {
            id
            name
            role
            files(filenames: ["config/settings_data.json"], first: 1) {
              nodes {
                body {
                  ... on OnlineStoreThemeFileBodyText {
                    content
                  }
                }
              }
            }
          }
        }
      }
    `;
}

export async function queryThemes(run: ThemeQueryRunner, roles: readonly string[], first: number): Promise<ThemeNode[]> {
  const data = await run(themeEmbedQuery(roles, first));
  if (data.errors?.length) {
    throw new Error(data.errors.map((error) => error.message ?? "Theme query failed").join("; "));
  }
  return data.data?.themes?.nodes ?? [];
}

/** The verdict for one theme, with the sentence the installation page shows. */
export function themeEmbedVerdict(theme: ThemeNode | undefined): { status: EmbedVerdict; detail: string } {
  const settingsContent = theme?.files?.nodes?.[0]?.body?.content;
  if (!settingsContent) return { status: "unknown", detail: "The published theme settings file was unavailable." };
  const status = detectPromoEngineEmbedStatus(settingsContent);
  return {
    status,
    detail: status === "enabled"
      ? "The published theme settings were read successfully."
      : "The published theme settings confirm that the Promo Engine app embed is not active.",
  };
}

/** The installation page: the published (MAIN) theme. A failed query leaves status "unknown". */
export async function checkPublishedThemeEmbed(
  run: ThemeQueryRunner,
  shopDomain: string,
): Promise<{ appEmbedStatus: EmbedVerdict; activeThemeId: string; statusDetail: string }> {
  let appEmbedStatus: EmbedVerdict = "unknown";
  let activeThemeId = "";
  let statusDetail = "Shopify did not return a verifiable app embed status.";

  try {
    const [mainTheme] = await queryThemes(run, ["MAIN"], 1);
    activeThemeId = mainTheme?.id ?? "";
    if (mainTheme?.files?.nodes?.[0]?.body?.content) {
      const verdict = themeEmbedVerdict(mainTheme);
      appEmbedStatus = verdict.status;
      statusDetail = verdict.detail;
    } else {
      statusDetail = "The published theme settings file was unavailable.";
    }
  } catch (error) {
    console.warn("[installation] Unable to verify app embed status", {
      shop: shopDomain,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
  return { appEmbedStatus, activeThemeId, statusDetail };
}

export interface ThemeEmbedStatus {
  themeId: string;
  name: string;
  role: string | null;
  status: EmbedVerdict;
  detail: string;
}

/** Per theme of the given roles; a theme whose settings cannot be parsed is "unknown", never a thrown error. */
export async function listThemeEmbedStatus(
  run: ThemeQueryRunner,
  roles: readonly string[],
  first = 10,
): Promise<ThemeEmbedStatus[]> {
  const themes = await queryThemes(run, roles, first);
  return themes.map((theme) => {
    let verdict: { status: EmbedVerdict; detail: string };
    try {
      verdict = themeEmbedVerdict(theme);
    } catch {
      verdict = { status: "unknown", detail: "The theme settings could not be parsed." };
    }
    return { themeId: theme.id, name: theme.name, role: theme.role ?? null, status: verdict.status, detail: verdict.detail.replace("published theme", "theme") };
  });
}
