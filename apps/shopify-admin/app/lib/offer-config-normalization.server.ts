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

  if ((conditionType === "specific_product" || conditionType === "pack_of_products") && !Array.isArray(value["requirements"])) {
    const isPack = conditionType === "pack_of_products";
    const quantity = Math.max(1, Number.isInteger(value["minQtyPerProduct"]) ? Number(value["minQtyPerProduct"]) : 1);
    const multiply = isPack
      ? { multiplyByPacks: value["multiplyByPacks"] === true || value["multiplyGifts"] === true }
      : { multiplyByGroups: value["multiplyByGroups"] === true || value["multiplyGifts"] === true };
    const qtyField = isPack ? "quantityPerPack" : "minQuantity";
    // The inline editor stores product GIDs in productIds when "Any variant of the product" is chosen.
    if (value["trackMode"] === "product" && Array.isArray(value["productIds"]) && value["productIds"].length > 0) {
      return {
        requirements: [...new Set(value["productIds"] as string[])].map((productId) => ({ productId, trackMode: "product", [qtyField]: quantity })),
        ...multiply,
      };
    }
    if (Array.isArray(value["variantIds"])) {
      return {
        requirements: (value["variantIds"] as string[]).map((variantId) => ({ variantId, trackMode: "variant", [qtyField]: quantity })),
        ...multiply,
      };
    }
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
