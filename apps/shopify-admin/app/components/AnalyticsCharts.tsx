/**
 * Analytics charts — uses recharts for real visualizations.
 * Used in analytics dashboard and per-offer analytics pages.
 */

import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
  LineChart, Line, PieChart, Pie, Cell, LabelList,
} from "recharts";
import { LegacyCard, Text, InlineStack } from "@shopify/polaris";

const COLORS = ["#111", "#6366f1", "#059669", "#f59e0b", "#ef4444", "#8b5cf6"];

// ── Conversion Funnel Chart ───────────────────────────────────────────────────

interface FunnelStep { label: string; count: number }

export function ConversionFunnelChart({ data }: { data: FunnelStep[] }) {
  const max = data[0]?.count ?? 1;
  const chartData = data.map((step, i) => ({
    name: step.label,
    value: step.count,
    fill: COLORS[i % COLORS.length],
  }));

  return (
    <LegacyCard title="Conversion Funnel" sectioned>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={chartData} layout="vertical" margin={{ left: 20, right: 40, top: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" horizontal={false} />
          <XAxis type="number" domain={[0, max]} tick={{ fontSize: 12 }} />
          <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 12 }} />
          <Tooltip
            formatter={(value: number, _name: string, props: { payload?: { pct?: number } }) => {
              const pct = props.payload?.pct;
              return [value.toLocaleString() + (pct ? ` (${pct}%)` : ""), ""];
            }}
          />
          <Bar dataKey="value" radius={[0, 4, 4, 0]}>
            {chartData.map((entry, i) => (
              <Cell key={i} fill={entry.fill} />
            ))}
            <LabelList
              dataKey="value"
              position="right"
              formatter={(v: number) => v.toLocaleString()}
              style={{ fontSize: 12 }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </LegacyCard>
  );
}

// ── Campaign Type Breakdown — Pie Chart ───────────────────────────────────────

interface CampaignRow { type: string; count: number }

const TYPE_LABELS: Record<string, string> = {
  gift: "🎁 Gift",
  bundle: "📦 Bundle",
  upsell: "⬆️ Upsell",
  discount: "💰 Discount",
  booster: "🚀 Booster",
};

export function CampaignBreakdownChart({ data }: { data: CampaignRow[] }) {
  const chartData = data.map((row, i) => ({
    name: TYPE_LABELS[row.type] ?? row.type,
    value: row.count,
    fill: COLORS[i % COLORS.length],
  }));

  const total = data.reduce((a, b) => a + b.count, 0);

  return (
    <LegacyCard title="Campaign Breakdown (30 days)" sectioned>
      <InlineStack gap="600" align="start">
        <ResponsiveContainer width={200} height={200}>
          <PieChart>
            <Pie
              data={chartData}
              cx="50%"
              cy="50%"
              innerRadius={50}
              outerRadius={90}
              paddingAngle={2}
              dataKey="value"
            >
              {chartData.map((entry, i) => (
                <Cell key={i} fill={entry.fill} />
              ))}
            </Pie>
            <Tooltip formatter={(v: number) => [`${v.toLocaleString()} (${total > 0 ? Math.round(v/total*100) : 0}%)`, ""]} />
          </PieChart>
        </ResponsiveContainer>
        <div style={{ flex: 1 }}>
          {chartData.map((item, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <div style={{ width: 12, height: 12, borderRadius: "50%", background: item.fill, flexShrink: 0 }} />
              <Text as="span" variant="bodySm">{item.name}</Text>
              <Text as="span" variant="bodySm" tone="subdued">{item.value.toLocaleString()}</Text>
            </div>
          ))}
        </div>
      </InlineStack>
    </LegacyCard>
  );
}

// ── Metric Line Chart (time series) ──────────────────────────────────────────

interface TimePoint { date: string; value: number }

export function MetricLineChart({ title, data, color = "#111" }: { title: string; data: TimePoint[]; color?: string }) {
  return (
    <LegacyCard title={title} sectioned>
      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={data} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="date" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 11 }} width={40} />
          <Tooltip formatter={(v: number) => [v.toLocaleString(), title]} />
          <Line
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </LegacyCard>
  );
}

// ── Top Offers Bar Chart ──────────────────────────────────────────────────────

interface OfferRow { name: string; adds: number }

export function TopOffersChart({ data }: { data: OfferRow[] }) {
  return (
    <LegacyCard title="Top Offers by Gift Adds" sectioned>
      <ResponsiveContainer width="100%" height={Math.max(120, data.length * 40)}>
        <BarChart data={data} layout="vertical" margin={{ left: 8, right: 40, top: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" horizontal={false} />
          <XAxis type="number" tick={{ fontSize: 11 }} />
          <YAxis type="category" dataKey="name" width={160} tick={{ fontSize: 11 }} />
          <Tooltip formatter={(v: number) => [v.toLocaleString(), "Adds"]} />
          <Bar dataKey="adds" fill="#111" radius={[0, 4, 4, 0]}>
            <LabelList
              dataKey="adds"
              position="right"
              formatter={(v: number) => v.toLocaleString()}
              style={{ fontSize: 11 }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </LegacyCard>
  );
}
