import { useLoaderData, useNavigate, useSearchParams, Form } from "react-router";
import {
  Page, IndexTable, Badge, Button, Filters, ChoiceList,
  EmptyState, Text, Thumbnail, InlineStack, LegacyCard,
  useIndexResourceState,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { offers } from "@promo/db";
import { eq, and, like, desc, sql } from "drizzle-orm";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

type OfferStatus = "draft" | "active" | "paused" | "scheduled" | "expired" | "archived";
type OfferType = "gift" | "bundle" | "upsell" | "discount" | "booster";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();
  const url = new URL(request.url);
  const typeFilter = url.searchParams.get("type") as OfferType | null;
  const statusFilter = url.searchParams.get("status") as OfferStatus | null;
  const search = url.searchParams.get("q") ?? "";

  const conditions = [];

  if (typeFilter) conditions.push(eq(offers.type, typeFilter));
  if (statusFilter) conditions.push(eq(offers.status, statusFilter));
  if (search) conditions.push(like(offers.internalName, `%${search}%`));

  const rows = await db
    .select({
      id: offers.id,
      type: offers.type,
      status: offers.status,
      internalName: offers.internalName,
      publicTitle: offers.publicTitle,
      priority: offers.priority,
      startsAt: offers.startsAt,
      endsAt: offers.endsAt,
      discountTags: offers.discountTags,
      updatedAt: offers.updatedAt,
    })
    .from(offers)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(offers.priority, desc(offers.updatedAt))
    .limit(100);

  return {
    offers: rows.map((row) => ({
      ...row,
      startsAt: row.startsAt?.toISOString() ?? null,
      endsAt: row.endsAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();
  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const offerIds = formData.getAll("offerIds[]") as string[];

  switch (intent) {
    case "bulk_pause":
      for (const id of offerIds) {
        await db.update(offers).set({ status: "paused", updatedAt: new Date() }).where(eq(offers.id, id));
      }
      break;
    case "bulk_activate":
      for (const id of offerIds) {
        await db.update(offers).set({ status: "active", updatedAt: new Date() }).where(eq(offers.id, id));
      }
      break;
    case "bulk_archive":
      for (const id of offerIds) {
        await db.update(offers).set({ status: "archived", archivedAt: new Date(), updatedAt: new Date() }).where(eq(offers.id, id));
      }
      break;
  }

  return null;
};

const STATUS_BADGE: Record<OfferStatus, { tone: "success" | "info" | "warning" | "critical" | "attention"; label: string }> = {
  active: { tone: "success", label: "Active" },
  draft: { tone: "info", label: "Draft" },
  paused: { tone: "warning", label: "Paused" },
  scheduled: { tone: "attention", label: "Scheduled" },
  expired: { tone: "critical", label: "Expired" },
  archived: { tone: "critical", label: "Archived" },
};

const TYPE_LABEL: Record<OfferType, string> = {
  gift: "🎁 Gift",
  bundle: "📦 Bundle",
  upsell: "⬆️ Upsell",
  discount: "💰 Discount",
  booster: "🚀 Booster",
};

export default function OffersPage() {
  const { offers: offerRows } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const { selectedResources, allResourcesSelected, handleSelectionChange, clearSelection } =
    useIndexResourceState(offerRows.map((o) => ({ id: o.id })));

  const promotedBulkActions = [
    { content: "Activate", onAction: () => submitBulkAction("bulk_activate") },
    { content: "Pause", onAction: () => submitBulkAction("bulk_pause") },
    { content: "Archive", onAction: () => submitBulkAction("bulk_archive") },
  ];

  function submitBulkAction(intent: string) {
    const form = document.createElement("form");
    form.method = "POST";
    const intentInput = document.createElement("input");
    intentInput.name = "intent";
    intentInput.value = intent;
    form.appendChild(intentInput);
    for (const id of selectedResources) {
      const input = document.createElement("input");
      input.name = "offerIds[]";
      input.value = id;
      form.appendChild(input);
    }
    document.body.appendChild(form);
    form.submit();
    clearSelection();
  }

  const rows = offerRows.map((offer) => ({
    id: offer.id,
    name: offer.internalName,
    type: (offer.type as OfferType),
    status: (offer.status as OfferStatus),
    priority: offer.priority,
    publicTitle: offer.publicTitle,
    updatedAt: new Date(offer.updatedAt).toLocaleDateString(),
  }));

  if (rows.length === 0) {
    return (
      <Page
        title="All Offers"
        primaryAction={{ content: "Create Offer", url: "/app/offers/new" }}
      >
        <LegacyCard sectioned>
          <EmptyState
            heading="Create your first promotion"
            action={{ content: "Create Gift Offer", url: "/app/offers/new" }}
            image=""
          >
            <p>Add free gifts, bundles, upsells and discounts to your store.</p>
          </EmptyState>
        </LegacyCard>
      </Page>
    );
  }

  return (
    <Page
      title="All Offers"
      primaryAction={{ content: "Create Offer", url: "/app/offers/new" }}
    >
      <LegacyCard>
        <IndexTable
          resourceName={{ singular: "offer", plural: "offers" }}
          itemCount={rows.length}
          selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
          onSelectionChange={handleSelectionChange}
          promotedBulkActions={promotedBulkActions}
          headings={[
            { title: "Offer" },
            { title: "Type" },
            { title: "Status" },
            { title: "Priority" },
            { title: "Updated" },
          ]}
        >
          {rows.map((row, index) => {
            const badge = STATUS_BADGE[row.status];
            return (
              <IndexTable.Row
                id={row.id}
                key={row.id}
                selected={selectedResources.includes(row.id)}
                position={index}
                onClick={() => navigate(`/app/offers/${row.id}`)}
              >
                <IndexTable.Cell>
                  <Text variant="bodyMd" fontWeight="semibold" as="span">
                    {row.name}
                  </Text>
                  <br />
                  <Text variant="bodySm" tone="subdued" as="span">
                    {row.publicTitle}
                  </Text>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <Text as="span">{TYPE_LABEL[row.type]}</Text>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <Badge tone={badge.tone}>{badge.label}</Badge>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <Text as="span">{row.priority}</Text>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <Text as="span">{row.updatedAt}</Text>
                </IndexTable.Cell>
              </IndexTable.Row>
            );
          })}
        </IndexTable>
      </LegacyCard>
    </Page>
  );
}
