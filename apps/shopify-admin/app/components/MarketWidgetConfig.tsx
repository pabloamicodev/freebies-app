/**
 * MarketWidgetConfig — UI component for per-market widget configuration.
 * Shown in the widget settings page to let merchants customize widget copy
 * and thresholds per Shopify Market.
 *
 * Uses the /api/markets endpoint to fetch available markets.
 */

import { useState, useEffect } from "react";
import {
  LegacyCard, BlockStack, InlineStack, Text, Badge, TextField,
  Spinner, Banner, Collapsible, Button, Box, Divider, Select,
} from "@shopify/polaris";
import type { ShopifyMarket } from "../lib/markets.server.js";

interface MarketOverride {
  marketId: string;
  /** Custom threshold in this market's currency (cents). Null = use auto-converted base. */
  thresholdCents: number | null;
  /** Custom widget title for this market. Null = use default. */
  widgetTitle: string | null;
  /** Whether this widget is enabled for this market. */
  enabled: boolean;
}

interface MarketWidgetConfigProps {
  widgetId: string;
  baseThresholdCents?: number;
  baseCurrencyCode?: string;
  /** Current overrides (loaded from DB). */
  defaultOverrides?: MarketOverride[];
  onSave: (overrides: MarketOverride[]) => Promise<void>;
}

export function MarketWidgetConfig({
  widgetId,
  baseThresholdCents,
  baseCurrencyCode = "USD",
  defaultOverrides = [],
  onSave,
}: MarketWidgetConfigProps) {
  const [markets, setMarkets] = useState<ShopifyMarket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<string, MarketOverride>>(
    Object.fromEntries(defaultOverrides.map((o) => [o.marketId, o])),
  );
  const [saving, setSaving] = useState(false);
  const [expandedMarket, setExpandedMarket] = useState<string | null>(null);

  // Fetch markets from API
  useEffect(() => {
    fetch("/api/markets")
      .then((r) => r.json() as Promise<{ markets: ShopifyMarket[] }>)
      .then(({ markets }) => {
        setMarkets(markets);
        // Initialize overrides for markets that don't have one yet
        setOverrides((prev) => {
          const next = { ...prev };
          for (const market of markets) {
            if (!next[market.id]) {
              next[market.id] = {
                marketId: market.id,
                thresholdCents: null,
                widgetTitle: null,
                enabled: true,
              };
            }
          }
          return next;
        });
      })
      .catch(() => setError("Could not load markets. Check Shopify Markets are configured."))
      .finally(() => setLoading(false));
  }, []);

  function updateOverride(marketId: string, patch: Partial<MarketOverride>) {
    setOverrides((prev) => ({
      ...prev,
      [marketId]: { ...prev[marketId]!, ...patch },
    }));
  }

  async function handleSave() {
    setSaving(true);
    try {
      const overrideList = Object.values(overrides).filter(
        (o) => o.thresholdCents !== null || o.widgetTitle !== null || !o.enabled,
      );
      await onSave(overrideList);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <LegacyCard sectioned>
        <InlineStack gap="300" align="center">
          <Spinner size="small" />
          <Text as="p">Loading markets…</Text>
        </InlineStack>
      </LegacyCard>
    );
  }

  if (error) {
    return (
      <Banner tone="warning" title="Markets unavailable">
        <p>{error}</p>
      </Banner>
    );
  }

  if (markets.length === 0) {
    return (
      <Banner tone="info" title="No Shopify Markets configured">
        <p>
          Add Shopify Markets in your store settings to configure per-market widget behavior.
          Without markets, the widget uses the store's default currency and locale.
        </p>
      </Banner>
    );
  }

  return (
    <LegacyCard title="Per-Market Widget Configuration" sectioned>
      <BlockStack gap="400">
        <Text as="p" tone="subdued">
          Customize the widget for each market. Leave fields empty to use the global default.
          {baseThresholdCents && (
            <> Base threshold: <strong>${(baseThresholdCents / 100).toFixed(2)} {baseCurrencyCode}</strong> — auto-converted for markets without a custom threshold.</>
          )}
        </Text>

        {markets.map((market) => {
          const override = overrides[market.id] ?? {
            marketId: market.id, thresholdCents: null, widgetTitle: null, enabled: true,
          };
          const isExpanded = expandedMarket === market.id;
          const hasCustomization = override.thresholdCents !== null || override.widgetTitle !== null || !override.enabled;

          return (
            <Box key={market.id} borderWidth="025" borderColor="border" borderRadius="200" padding="400">
              <InlineStack align="space-between" blockAlign="center">
                <InlineStack gap="300" blockAlign="center">
                  <Text as="p" fontWeight="semibold">{market.name}</Text>
                  <Badge tone={market.enabled ? "success" : undefined}>{market.currencyCode}</Badge>
                  {market.primary && <Badge tone="info">Primary</Badge>}
                  {hasCustomization && <Badge tone="attention">Customized</Badge>}
                  {!override.enabled && <Badge tone="critical">Disabled</Badge>}
                </InlineStack>

                <Button
                  variant="plain"
                  onClick={() => setExpandedMarket(isExpanded ? null : market.id)}
                >
                  {isExpanded ? "Collapse ▲" : "Configure ▼"}
                </Button>
              </InlineStack>

              <Collapsible open={isExpanded} id={`market-${market.id}`}>
                <Box paddingBlockStart="400">
                  <BlockStack gap="300">
                    <InlineStack gap="300" blockAlign="center">
                      <input
                        type="checkbox"
                        checked={override.enabled}
                        onChange={(e) => updateOverride(market.id, { enabled: e.target.checked })}
                        id={`enabled-${market.id}`}
                        style={{ width: 16, height: 16 }}
                      />
                      <label htmlFor={`enabled-${market.id}`}>
                        <Text as="span">Widget enabled for {market.name}</Text>
                      </label>
                    </InlineStack>

                    <Divider />

                    <TextField
                      label={`Custom threshold (${market.currencyCode})`}
                      helpText={`Leave empty to auto-convert from ${baseThresholdCents ? `$${(baseThresholdCents / 100).toFixed(2)} ${baseCurrencyCode}` : "base threshold"}.`}
                      type="number"
                      value={override.thresholdCents !== null ? String(override.thresholdCents / 100) : ""}
                      onChange={(v) => updateOverride(market.id, {
                        thresholdCents: v ? Math.round(parseFloat(v) * 100) : null,
                      })}
                      prefix={market.currencyCode}
                      autoComplete="off"
                      disabled={!override.enabled}
                    />

                    <TextField
                      label="Custom widget title"
                      helpText={`Override the widget title for ${market.name} (${market.primaryLocale}).`}
                      value={override.widgetTitle ?? ""}
                      onChange={(v) => updateOverride(market.id, { widgetTitle: v || null })}
                      autoComplete="off"
                      placeholder="e.g. Gratis Geschenk ab 50 €"
                      disabled={!override.enabled}
                    />

                    {market.countryCodes.length > 0 && (
                      <Text as="p" variant="bodySm" tone="subdued">
                        Countries: {market.countryCodes.join(", ")}
                      </Text>
                    )}
                  </BlockStack>
                </Box>
              </Collapsible>
            </Box>
          );
        })}

        <InlineStack align="end">
          <Button variant="primary" onClick={handleSave} loading={saving}>
            Save Market Configuration
          </Button>
        </InlineStack>
      </BlockStack>
    </LegacyCard>
  );
}
