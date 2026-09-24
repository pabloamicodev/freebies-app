export function normalizeConditionValue(conditionType: string, rawValue: unknown): Record<string, unknown> {
  const value = isRecord(rawValue) ? rawValue : {};
  if (conditionType === "customer_tags" && !Array.isArray(value["includeTags"]) && !Array.isArray(value["excludeTags"])) {
    const tags = parseCommaList(value["tags"]);
    return {
      includeTags: value["exclude"] === true ? [] : tags,
      excludeTags: value["exclude"] === true ? tags : [],
      treatGuestAsNoTags: value["guest"] !== false,
    };
  }

  if (conditionType === "customer_location" && !Array.isArray(value["includeCountryCodes"]) && !Array.isArray(value["excludeCountryCodes"])) {
    const countries = parseCommaList(value["countries"]).map((country) => country.toUpperCase());
    return {
      includeCountryCodes: value["exclude"] === true ? [] : countries,
      excludeCountryCodes: value["exclude"] === true ? countries : [],
    };
  }

  if (conditionType === "sales_channels" && !Array.isArray(value["channels"])) {
    return {
      channels: [
        ...(value["online"] !== false ? ["online_store"] : []),
        ...(value["mobile"] === true ? ["mobile_app"] : []),
        ...(value["pos"] === true ? ["pos"] : []),
      ],
    };
  }

  if (conditionType === "markets" && !Array.isArray(value["includeMarketIds"]) && !Array.isArray(value["excludeMarketIds"])) {
    const marketIds = parseCommaList(value["marketIds"]);
    return {
      includeMarketIds: value["exclude"] === true ? [] : marketIds,
      excludeMarketIds: value["exclude"] === true ? marketIds : [],
    };
  }

  if (conditionType === "subscription_product_type") {
    const mode = value["mode"];
    if (mode === "subscription" || mode === "one_time") {
      return { ...value, mode: mode === "subscription" ? "subscription_only" : "one_time_only" };
    }
  }

  if (conditionType === "cart_value" && value["maxCents"] === undefined && value["maxAmountCents"] !== undefined) {
    return {
      ...value,
      maxCents: value["maxAmountCents"],
    };
  }

  if (conditionType === "specific_product" && !Array.isArray(value["requirements"]) && Array.isArray(value["variantIds"])) {
    const minQuantity = Number.isInteger(value["minQtyPerProduct"]) ? Number(value["minQtyPerProduct"]) : 1;
    return {
      requirements: (value["variantIds"] as string[]).map((variantId) => ({
        variantId,
        trackMode: "variant",
        minQuantity: Math.max(1, minQuantity),
      })),
      multiplyByGroups: value["multiplyByGroups"] === true || value["multiplyGifts"] === true,
    };
  }

  if (conditionType === "pack_of_products" && !Array.isArray(value["requirements"]) && Array.isArray(value["variantIds"])) {
    const quantityPerPack = Number.isInteger(value["minQtyPerProduct"]) ? Number(value["minQtyPerProduct"]) : 1;
    return {
      requirements: (value["variantIds"] as string[]).map((variantId) => ({
        variantId,
        trackMode: "variant",
        quantityPerPack: Math.max(1, quantityPerPack),
      })),
      multiplyByPacks: value["multiplyByPacks"] === true || value["multiplyGifts"] === true,
    };
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCommaList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value !== "string") return [];
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}
