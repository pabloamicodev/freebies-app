export type AppEmbedStatus = "enabled" | "disabled";

interface ThemeSettings {
  current?: {
    blocks?: Record<string, { type?: string; disabled?: boolean }>;
  };
}

function stripLeadingThemeComments(content: string): string {
  let remaining = content.replace(/^\uFEFF/, "").trimStart();

  while (remaining.startsWith("/*") || remaining.startsWith("//")) {
    if (remaining.startsWith("/*")) {
      const end = remaining.indexOf("*/");
      if (end === -1) {
        throw new SyntaxError("Unterminated block comment in theme settings");
      }
      remaining = remaining.slice(end + 2).trimStart();
      continue;
    }

    const end = remaining.indexOf("\n");
    if (end === -1) {
      throw new SyntaxError("Theme settings contain a comment but no JSON document");
    }
    remaining = remaining.slice(end + 1).trimStart();
  }

  return remaining;
}

export function detectPromoEngineEmbedStatus(content: string): AppEmbedStatus {
  const settings = JSON.parse(stripLeadingThemeComments(content)) as ThemeSettings;
  const promoEngineEmbed = Object.values(settings.current?.blocks ?? {}).find((block) => {
    const type = block.type?.toLowerCase() ?? "";
    return (
      type.includes("/blocks/app_embed/") &&
      (type.includes("/apps/promo-engine/") || type.includes("/apps/promo-engine-hpn/"))
    );
  });

  if (!promoEngineEmbed || promoEngineEmbed.disabled === true) {
    return "disabled";
  }

  return "enabled";
}
