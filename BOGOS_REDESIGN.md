# BOGOS.io Free Gift — UI Redesign Plan (1:1 Replica)

> All implementation must be pixel-perfect against the 4 provided screenshots.
> Tick each checkbox as you complete the item.

---

## 0. Navigation Architecture

```
Shopify Admin Sidebar (NavMenu — rendered by App Bridge, not controllable)
├── BOGOS.io Free Gift  →  /app            (Panel/Dashboard)
├── Todas las ofertas   →  /app/offers     (All Offers)
├── Impulsores          →  /app/boosters   (Boosters)
├── Personalizar        →  /app/customize  (Customize)
├── Analítica           →  /app/analytics  (Analytics)
├── Ajustes             →  /app/settings   (Settings)
├── Traducción          →  /app/translation
├── Fijación de precios →  /app/pricing
├── Integraciones       →  /app/integrations
└── Ver menos           (collapse toggle — Shopify renders this automatically)
```

### Route Flow Diagram

```
[/app]             → Dashboard (Panel)
                       └─ "Crear oferta" btn → /app/offers/new
                                                  └─ type selector → /app/offers/:id

[/app/offers]      → All Offers list
  Tabs: All | Active | Disabled | Scheduled | Expired
  Each row → /app/offers/:id (edit)
  "Crear oferta" → /app/offers/new

[/app/offers/new]  → Create Offer (wizard step 1: type + name)
                       └─ Submit → /app/offers/:id (conditions step)

[/app/offers/:id]  → Offer Editor
  Sub-tabs: Conditions | Rewards | Widget | Schedule | Combination | Priority

[/app/analytics]   → Analytics
  Filters: offer type | offer selector | date range

[/app/settings]    → Settings (multi-section single page)

[/app/customize]   → Customize (widget theme)

[/app/boosters]    → Boosters list (Today Offer widgets, progress bars)

[/app/translation] → Translation settings

[/app/pricing]     → Pricing plans (stub page)

[/app/integrations]→ Integrations (stub page)
```

---

## 1. Design Tokens

```css
/* colors */
--bg-page:          #f1f2f4
--bg-card:          #ffffff
--border:           #e5e7eb
--border-light:     #f3f4f6

--text:             #202223
--text-sub:         #6d7175
--text-muted:       #8c9196

--blue:             #2c6ecb   /* primary buttons, links, active underline */
--blue-light:       #eff6ff   /* banner bg */
--blue-border:      #bfdbfe

--green:            #008060   /* active status text */
--green-bg:         #f0f9f5
--green-badge-bg:   #d1fae5   /* "Activo" badge fill */
--green-badge-text: #065f46

--orange-badge-bg:  #fff7ed   /* "Venció" badge fill */
--orange-badge-text:#c2410c

--gray-badge-text:  #6d7175   /* "Desactivado" (text only, no bg) */

--red:              #dc2626
--red-bg:           #fef2f2
--red-btn:          #d72c0d

--toggle-on:        #2c6ecb
--toggle-off:       #babec3

--shadow-card:      0 1px 0 rgba(0,0,0,0.05)

/* spacing scale (4px base) */
--sp-1: 4px  --sp-2: 8px   --sp-3: 12px  --sp-4: 16px
--sp-5: 20px --sp-6: 24px  --sp-8: 32px  --sp-10: 40px

/* radius */
--r-sm: 4px   --r: 8px   --r-lg: 12px   --r-pill: 9999px
```

---

## 2. Shared Component Library

### 2a. BogosStatusBadge
Variants: `active | disabled | expired | scheduled | draft`

| variant    | bg          | text        | border     |
|------------|-------------|-------------|------------|
| active     | #d1fae5     | #065f46     | none       |
| disabled   | transparent | #6d7175     | none (text only) |
| expired    | #fff7ed     | #c2410c     | none       |
| scheduled  | #eff6ff     | #2c6ecb     | none       |
| draft      | #f3f4f6     | #6d7175     | none       |

Shape: `border-radius: 9999px`, `padding: 2px 10px`, `font-size: 12px`, `font-weight: 500`

### 2b. BogosToggle
```
OFF: oval 36×20px, bg #babec3, white circle 16×16 translateX(2px)
ON:  oval 36×20px, bg #2c6ecb, white circle 16×16 translateX(18px)
transition: 0.15s ease
```

### 2c. BogosTypeBadge
Single variant: type chip (e.g. "Regalo")
- bg: #f1f2f4, text: #6d7175, radius: 9999px, padding: 2px 10px, font-size: 12px

### 2d. BogosBanner (info)
- bg: #eff6ff, border-left: 4px solid #2c6ecb (or no left border, just bg + icon)
- Icon: blue ℹ circle on left
- Close button: × on far right
- `border-radius: 8px`

### 2e. BogosFilterTabs
- Row of text tabs
- Active tab: blue bottom border 2px, text color --blue
- Inactive tab: gray text, no border
- Right side: search icon + filter icon (gray, 20px)

### 2f. BogosCard
- bg: white, border: 1px solid #e5e7eb, border-radius: 8px, box-shadow: var(--shadow-card)
- Padding: 20px

### 2g. BogosButton
| variant   | bg       | text    | border              |
|-----------|----------|---------|---------------------|
| primary   | #008060  | white   | none                |
| secondary | white    | #202223 | 1px solid #babec3   |
| danger    | #d72c0d  | white   | none                |
| plain     | transparent | #2c6ecb | none               |

Wait — looking at "Crear oferta" button it appears to be standard Shopify Polaris green (#008060). Let me confirm by looking at the primary action button color in the screenshots. Yes, it appears green (Polaris default).

Actually looking at screenshot 1, "Crear oferta" button has a darker/slightly different shade. Let me use Polaris's primary which is `#008060`.

### 2h. SvgLineChart (Analytics)
Simple SVG line chart:
- X-axis: date labels
- Y-axis: value labels  
- Single line path, blue (#2c6ecb), strokeWidth 2
- Area fill: light blue rgba(44,110,203,0.08)
- Grid lines: #f3f4f6 horizontal
- Dot at each data point: 4px circle, white fill, blue border

### 2i. BogosGiftIcon (for offer rows)
- 32×32px div: background #ff6b35 (orange/coral), border-radius 6px
- White gift emoji/SVG centered

### 2j. PersonIllustration (CSS art for Dashboard welcome card)
Pure HTML/CSS figures:
- Circle head: 24px, bg #f59e0b (amber)
- Body rectangle: bg #3b82f6
- Arms: small rectangles
- Boxes: 3 orange/brown squares stacked

### 2k. TeamIllustration (for dark banner)
- 4–5 circular avatar placeholders (different color fills)
- Arranged overlapping in a row

---

## 3. Page Specifications

### 3a. Page: All Offers `/app/offers`

```
┌─────────────────────────────────────────────────────────────┐
│ Todas las ofertas                    [Más acciones ▾] [Crear oferta] │
├─────────────────────────────────────────────────────────────┤
│ ℹ️  Integración del carrito                                     [×] │
│    Si está utilizando un cajón de carrito... Envianos un mensaje    │
├─────────────────────────────────────────────────────────────┤
│ [Todo] [Activo] [Desactivado] [Programado] [Venció]    🔍 ⊟ │
├─────────────────────────────────────────────────────────────┤
│ ☐  Título              Tipo        Fecha      Estado  On/Off  •••  │
│────────────────────────────────────────────────────────────│
│ ☐ 🎁 Offer Name       [Regalo]   may 9, 2026 [Venció]  ○    ⧉ 🗑 │
│    Subtitle text                                                    │
│ ☐ 🎁 Offer Name       [Regalo]   abr 6, 2026 [Activo]  ●    ⧉ 🗑 │
│    ...                                                              │
└─────────────────────────────────────────────────────────────┘
```

**Header**:
- Title: "Todas las ofertas", font-size 20px, font-weight 600
- "Más acciones" button: secondary outlined, with dropdown chevron
- "Crear oferta" button: primary (Polaris green)

**Info Banner**:
- bg: #eff6ff, border: 1px solid #bfdbfe, border-radius: 8px, padding: 12px 16px
- Left: blue info SVG icon (18px circle with "i")
- Title bold: "Integración del carrito"
- Text + "Envianos un mensaje" link (underlined)
- Close X button: right-aligned, gray, 18px

**Filter Tabs**:
- Container: border-bottom: 1px solid #e5e7eb, padding-bottom: 0
- Tab: padding: 12px 16px, font-size: 14px
- Active: color: #2c6ecb, border-bottom: 2px solid #2c6ecb
- Inactive: color: #6d7175

**Table**:
- Container: no card border (inside implicit card)
- Header row: bg #f9fafb, font-size 13px, text: #6d7175, font-weight 500, uppercase? no — mixed case
  - Cols: Título | Tipo de oferta | Fecha de inicio | Estado | Encendido apagado | Comportamiento
- Row: bg white, hover: #f9fafb, border-bottom: 1px solid #f3f4f6
- Checkbox: 16px standard checkbox left of row
- Gift icon: 32×32 rounded square, coral/orange bg
- Title: font-size 14px, font-weight 600, color #202223
- Subtitle: font-size 12px, color #6d7175, margin-top 2px
- Type badge: see BogosTypeBadge
- Date: font-size 13px, color #6d7175
- Status badge: see BogosStatusBadge
- Toggle: see BogosToggle
- Action icons: copy icon (gray) + delete icon (red), 18px each, gap 8px

### 3b. Page: Dashboard `/app`

```
┌──────────────────────────────────────────────────────┐
│ Panel              ● 0 bloqueos de la aplicación activos │
├──────────────────────────────────────────────────────┤
│ [Estado BOGOS][Activado]   │  [Plan de aplicación][Plan completo] │
│  BOGOS está activo...      │   Estás en el plan...               │
├──────────────────────────────────────────────────────┤
│ ████████████ FREE check with experts ████████████████ │
│  No te lo pierdas... [Consultar ofertas]   [👤👤👤👤] │
├──────────────────────────────────────────────────────┤
│ [Welcome card + illustration]  │  [Descripción general]         │
│  Bienvenido a BOGOS, Sean      │   Ventas totales     $1.9K     │
│  Crea una oferta...            │   Valor medio        $78       │
│  [Crear oferta]                │   Pedidos            24        │
├──────────────────────────────────────────────────────┤
│ Guía de inicio de BOGOS                          [×] │
│ 2/4 steps ████████░░░░                               │
│ ✅ Habilitar BOGOS en temas                          │
│ ✅ Crea tu primera oferta                            │
│ ○  Consulta la oferta en tu Tienda Online            │
│ ○  Personaliza la apariencia                         │
├──────────────────────────────────────────────────────┤
│ Aplicaciones recomendadas para ti              [×]   │
│ [App1][App2][App3]                                   │
├──────────────────────────────────────────────────────┤
│ Obtener apoyo                                        │
│ [Chat live] [Ver FAQ] | [YouTube] [Email]            │
└──────────────────────────────────────────────────────┘
```

**Page header**:
- "Panel" title: 20px, 600 weight
- Badge: small pill, green dot + "0 bloqueos de la aplicación activos", bg #f0f9f5, text #065f46, border: 1px solid #a7d9c8

**Status cards row** (2 col, equal width):
- Card: bg white, border: 1px solid #e5e7eb, border-radius 8px, padding 20px
- "Estado BOGOS" label: 13px, color #6d7175
- "Activado" badge: green pill (bg #d1fae5, text #065f46)
- Description: 14px, color #6d7175
- Same for Plan card

**Dark promo banner**:
- bg: #0f0f1a (very dark navy), color white
- border-radius: 8px, padding: 20px 24px
- Left: "FREE check with experts" h3 bold white
- Subtitle: gray text (#9ca3af)
- "Consultar ofertas" button: bg #008060 or #10b981, text white, border-radius 6px
- Right: 4 overlapping colored circles (CSS avatar placeholders)

**Welcome + Stats row** (2 col, 60/40 or equal split):
Welcome card:
- CSS person illustration (right side of card), see component 2j
- "Bienvenido a BOGOS, Sean": 18px, 700
- Subtitle: 14px, gray
- "Crear oferta" button: primary

Stats card "Descripción general":
- Each metric row: label left, value right (bold large)
- Dividers between rows
- Values: "Ventas totales $1.9K", "Valor medio del pedido $78", "Pedidos 24"

**Onboarding card**:
- Close X top right
- Title "Guía de inicio de BOGOS"
- "2/4 steps completed" label + progress bar (dark fill)
  - Progress bar: 44px height? No: 8px height, bg #e5e7eb, fill #111111, border-radius pill
- 4 checklist items:
  - Checked: blue/green filled circle with white checkmark
  - Unchecked: empty circle, border 1.5px #d1d5db

**Recommended apps** card:
- Close X top right
- Title
- 3 app cards side by side (each: rounded border, icon, badge, name, desc, button)

**Support section**:
- No card wrapper needed (or light card)
- Title "Obtener apoyo"
- 2×2 grid of clickable rows:
  - Each: icon (20px) | title bold | desc | chevron right
  - border-bottom separating items
  - hover: bg #f9fafb

### 3c. Page: Analytics `/app/analytics`

```
┌────────────────────────────────────────────────────────┐
│ Analítica                                [Exportar datos ▾] │
├────────────────────────────────────────────────────────┤
│ [Oferta de regalos ▾] [Todas las ofertas ▾] [Los últimos 7 días ▾] │
├──────────────┬──────────────┬──────────────────────────┤
│ Ventas tot.  │ Valor medio  │ Pedidos                  │
│ $1.9K  💲    │ $78   📋     │ 24  📦                   │
├──────────────┴──────────────┴──────────────────────────┤
│ Total                                                   │
│ [Ventas totales chart] | [Pedidos totales chart]        │
├────────────────────────────────────────────────────────┤
│ Pedidos                                                 │
│ [🔍 Buscar ordenes]                                     │
│  Orden │ Fecha │ Regalo            │ Total │ Acción     │
│  #7632 │ fecha │ 🎁 Gift name (%)  │ $58   │ 👁 🗑     │
│  ...                                                    │
│ ← 1 →                                                   │
└────────────────────────────────────────────────────────┘
```

**Header**: "Analítica" title + "Exportar datos" secondary button with dropdown chevron

**Filter chips row**:
- Each chip: border: 1px solid #e5e7eb, border-radius: 6px, padding: 6px 12px
- Text + dropdown arrow, font-size: 13px
- Active/hover: slightly darker border

**Stats cards** (3 col equal):
- Card: white, border, rounded, padding 16px 20px
- Value: 28px, 700, color #202223
- Label: 13px, gray below value
- Icon: 40px colored circle, right side
  - Sales: purple circle with $ SVG
  - AOV: blue circle with clipboard SVG
  - Orders: yellow circle with box SVG

**Charts section**:
- Title "Total" above charts
- 2 cards side by side, each: white card, title, SVG line chart
- Chart: width 100%, height ~180px
- X-axis: date labels (may 27, may 29, may 31)
- Y-axis: value labels ($0, $200, $400 or 0, 2, 4, 6)
- Line: color #2c6ecb, strokeWidth 2
- Legend: small blue line + label below chart

**Orders table**:
- "Pedidos" title above table
- Search bar: full width, placeholder "Buscar ordenes", border: 1px solid #e5e7eb, rounded
- Table: Orden | Fecha | Regalo | Total | Acción
  - Orden: "#76323" blue link
  - Fecha: "jun 2 2026, 10:37 am" in gray
  - Regalo: 🎁 emoji + gift name + "(100% off) x1", stacked list if multiple
  - Total: "$58.14"
  - Acción: eye icon (gray) + delete icon (red)
- Pagination: ← 1 → centered at bottom

### 3d. Page: Settings `/app/settings`

Two-column layout throughout (label col + control col):

```
┌──────────────────────────────────────────────────────────────┐
│ Ajustes                                                       │
├─────────────────────────┬────────────────────────────────────┤
│ General                 │ Estado BOGOS  [Activado]  [Desactivar] │
│ Gestionar los ajustes   │ No desactive... si hay ofertas activas │
│ generales de BOGOS      │ Zona horaria: [select]              │
│                         │ Idioma: [select]                    │
├─────────────────────────┼────────────────────────────────────┤
│ Mecanismo de lógica     │ Elija entre estas lógicas:          │
│ de regalo               │ ┌──────────────┐ ┌──────────────┐  │
│ Gestionar el mecanismo  │ │ [illustration]│ │[illustration] │  │
│ lógico de la oferta     │ │Producto clona.│ │Función regalo│  │
│ de regalo               │ │[Actualmente]  │ │              │  │
│                         │ │[Cambiar lóg.] │ │[Cambiar lóg.]│  │
│                         │ └──────────────┘ └──────────────┘  │
│                         │ ⚠️ warning + [Soporte de contacto]  │
├─────────────────────────┼────────────────────────────────────┤
│ Condición de regalo     │ ☑ Agregar automáticamente regalo    │
│                         │ Descuento calculado por:            │
│                         │ ● Precio actual  ○ Comparar precio │
│                         │ ☐ precio del regalo = precio prod.  │
│                         │ ☐ Limite de una selección...        │
│                         │ ☐ Excluir producto en el carrito    │
├─────────────────────────┼────────────────────────────────────┤
│ Producto de regalo      │ ☑ Eliminar productos...             │
│ clonado                 │ ☐ Incluir precio de comparación...  │
│                         │ Clonar formato SKU: [select]        │
│                         │ Clonar barcode: [select]            │
│                         │ Clonar título: [🎁 nombre (100% off)]│
│                         │ Canales de venta: [Editar]          │
│                         │ ● Online Store                      │
│                         │ Incluir detalles originales:        │
│                         │ ☐ Tipo de producto  ☐ Etiquetas    │
├─────────────────────────┼────────────────────────────────────┤
│ Gestión de inventario   │ Método de inventario: [select]      │
│ de regalos              │ Cuando agotado: ● Detener ○ Seguir │
├─────────────────────────┼────────────────────────────────────┤
│ Protección contra fraude│ ☑ Notificar vía correo electrónico │
│                         │   [email input field]               │
│                         │ ☑ Regla de protección (Recomendado)│
│                         │   Condición adicional: ● Todas ○ Cualquiera │
│                         │   ☐ Valor mínimo del carrito        │
│                         │   ☐ Cantidad mínima de carrito      │
│                         │   ☐ Número máximo de regalos        │
│                         │ ☐ Aplicar config por oferta         │
│                         │ ☐ Protección de pedidos             │
├─────────────────────────┼────────────────────────────────────┤
│ Avanzado                │ ☐ API de pedido preliminar          │
│                         │   [description text]                │
├─────────────────────────┼────────────────────────────────────┤
│ Restablecer datos       │ [description text]                  │
│ de la aplicación        │ ⚠️ Esta acción no se puede revertir! │
│                         │ [Soporte de contacto] [Restablecer] │
└─────────────────────────┴────────────────────────────────────┘
│ BOGOS Términos y condiciones ↗                               │
└──────────────────────────────────────────────────────────────┘
```

**Section layout**:
- Full-width card per section
- Left col: ~25% width, padding 20px
  - Section title: 14px, 600, color #202223
  - Section desc: 13px, color #6d7175, margin-top 4px
- Right col: ~75%, padding 20px, border-left: 1px solid #f3f4f6
- Section divider: border-top: 1px solid #e5e7eb between sections

**Gift logic card picker**:
- 2 side-by-side cards (~45% each, gap 16px)
- Card: border: 2px solid (active: #2c6ecb or #e5e7eb inactive), border-radius 8px, padding 16px
- Active card: "Actualmente habilitado" green badge on top
- CSS Illustration per card:
  - Clone: shopping bag with arrow/duplicate icon (CSS shapes)
  - Function: discount tag icon (CSS shapes)
- Title: 14px, 600
- Description: 13px, gray, 3 lines
- "Cambiar lógica" button: secondary small

**Orange warning box** (for logic change):
- bg: #fff7ed, border: 1px solid #fcd34d, border-radius 6px, padding 12px
- ⚠️ icon + text + "Soporte de contacto" button

**Fraud protection "Recomendado" badge**:
- Small inline pill: bg #eff6ff, text #2c6ecb, border: 1px solid #bfdbfe

**"Restablecer aplicación" section**:
- Red warning box at bottom: bg #fef2f2, border: 1px solid #fca5a5
- "⚠️ Esta acción no se puede revertir!" warning text
- Danger button: bg #d72c0d, text white

### 3e. Page: Create Offer `/app/offers/new`

Keep existing loader/action. Style the UI to match a clean wizard:
- Back button ← "All Offers"
- "Create New Offer" title
- Step cards: type selector with radio-style visual cards
- Details card: internal name, public title, priority inputs
- Footer: Cancel | Create & Continue →

---

## 4. Implementation Checklist

### CSS & Shared Components
- [x] Create `apps/shopify-admin/app/styles/bogos.css` with all design tokens
- [x] Toggle component — inline in `app.offers.tsx`
- [x] StatusBadge component — inline in `app.offers.tsx`
- [x] FilterTabs component — inline in `app.offers.tsx`
- [x] Card, Banner, LineChart — inline in respective routes
- [x] Update `apps/shopify-admin/app/routes/app.tsx` — link bogos.css, update NavMenu

### Pages
- [x] Rewrite `app._index.tsx` — Dashboard (Panel)
- [x] Rewrite `app.offers.tsx` — All Offers
- [x] Rewrite `app.analytics.tsx` — Analytics
- [x] Rewrite `app.settings.tsx` — Settings
- [x] Update `app.offers.new.tsx` — Create Offer wizard

### Audit
- [x] Screenshot 1 vs All Offers — tabs, table, toggles, badges, banner confirmed
- [x] Screenshot 2 vs Dashboard — status cards, dark banner, welcome, onboarding, apps, support confirmed
- [x] Screenshot 3 vs Analytics — filter chips, stat cards, charts, orders table confirmed
- [x] Screenshot 4 vs Settings — 2-col sections, logic cards, fraud protection, reset confirmed

## 6. Offer Creation Flow (Batch 2)

### Flow
```
[Crear oferta] button click
  → Modal 1: "Choose the type of offer"
      4 offer type cards (Gift / Bundle / Upsell / Discount)
      Each card: blue-gradient icon + name + "Example" tag + bullet list + "Start >" button
  → click "Start >" on Gift
  → Modal 2: "Create gift offer"
      • "Start from scratch" dashed card (selected state)
      • O divider
      • "Choose a template:" grid (3×2)
          - Cart Value → Gift
          - Free sample with purchase
          - BOGO
          - Buy X Get Y
          - Tiered spend with gifts
          - Custom form
      Footer: "Back" (secondary) + "Create offer" (dark filled)
  → click "Create offer"
  → POST /app/offers/new → redirect to /app/offers/:id
  → Offer editor page (full page, not modal):
      Left (65%): Offer info section + Main condition + Subcondition row + Select gifts + Advanced accordion + Footer
      Right (35%): Support card + Summary sidebar + Offer info metadata
```

### Implementation
- [x] Modal CSS in bogos.css (overlay, type cards, template grid, offer editor)
- [x] Modal 1 (type selector) in app.offers.tsx
- [x] Modal 2 (gift wizard with templates) in app.offers.tsx
- [x] Offer editor page (app.offers.$id.tsx) — full redesign

---

## 5. File Map

```
apps/shopify-admin/app/
  styles/
    bogos.css                       ← NEW: full design system
  components/
    ui/
      Toggle.tsx                    ← NEW: custom toggle switch
      StatusBadge.tsx               ← NEW: offer status badge
      TypeBadge.tsx                 ← NEW: offer type chip
      FilterTabs.tsx                ← NEW: tab navigation
      LineChart.tsx                 ← NEW: SVG line chart
      StatCard.tsx                  ← NEW: analytics stat card
      SectionRow.tsx                ← NEW: settings 2-col row
      BogosBanner.tsx               ← NEW: info banner
  routes/
    app.tsx                         ← UPDATE: import bogos.css, update NavMenu
    app._index.tsx                  ← REWRITE: Dashboard
    app.offers.tsx                  ← REWRITE: All Offers
    app.analytics.tsx               ← REWRITE: Analytics
    app.settings.tsx                ← REWRITE: Settings
    app.offers.new.tsx              ← UPDATE: Create Offer styling
    app.customize.tsx               ← UPDATE: Customize styling
```
