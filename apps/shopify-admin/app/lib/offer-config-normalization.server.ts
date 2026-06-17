export function normalizeConditionValue(conditionType: string, value: Record<string, unknown>): Record<string, unknown> {
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
