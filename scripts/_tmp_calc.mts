const fs = await import("node:fs");
process.loadEnvFile(".env");
const ctx = JSON.parse(fs.readFileSync(process.argv[2]!, "utf8"));
const { shopifyGraphQL } = await import("../apps/shopify-admin/app/lib/shopify-fetch.server.js");
const shop = "hpn-test-store.myshopify.com";
const gql = (query: string, variables: any) => shopifyGraphQL<any>({ shopDomain: shop, accessToken: ctx.accessToken, query, variables });
const rule = (k: string) => ctx.rules.find((r: any) => r.internal_name.endsWith(k)).target;
const firstVariants = async (ids: string[]) => (await gql(`query($ids:[ID!]!){nodes(ids:$ids){... on Product{id title variants(first:1){nodes{id}}}}}`, { ids })).nodes.map((p: any) => p.variants.nodes[0].id);
async function calc(name: string, lineItems: any[]) {
  const r = await gql(`mutation($input: DraftOrderInput!){draftOrderCalculate(input:$input){calculatedDraftOrder{ totalDiscountsSet{shopMoney{amount}} lineItems{ title quantity originalTotalSet{shopMoney{amount}} discountedTotalSet{shopMoney{amount}} } } userErrors{field message}}}`, { input: { lineItems } });
  const d = r.draftOrderCalculate;
  console.log(`\n## ${name}  discount=${d.calculatedDraftOrder?.totalDiscountsSet.shopMoney.amount}`, d.userErrors.length ? JSON.stringify(d.userErrors) : "");
  for (const l of d.calculatedDraftOrder?.lineItems ?? []) console.log(`  ${l.quantity}x ${l.title.slice(0,40).padEnd(40)} ${l.originalTotalSet.shopMoney.amount} -> ${l.discountedTotalSet.shopMoney.amount}`);
}
const t = rule("landing-scoped-product-mtvt54kq");
const attr = [{ key: "__landing_source", value: t.requiredLineAttributeValue }];
const targets = await firstVariants(t.productIds);
await calc("combo: 2 anchors + targets (expect targets free)", [
  { variantId: t.requiredAnchorVariantIds[0], quantity: 2, customAttributes: attr },
  ...targets.map((v: string) => ({ variantId: v, quantity: 1, customAttributes: attr })),
]);
await calc("combo: 1 anchor (expect no discount)", [
  { variantId: t.requiredAnchorVariantIds[0], quantity: 1, customAttributes: attr },
  ...targets.map((v: string) => ({ variantId: v, quantity: 1, customAttributes: attr })),
]);
await calc("combo: targets without landing attribute (expect no discount)", [
  { variantId: t.requiredAnchorVariantIds[0], quantity: 2, customAttributes: attr },
  ...targets.map((v: string) => ({ variantId: v, quantity: 1 })),
]);
process.exit(0);
