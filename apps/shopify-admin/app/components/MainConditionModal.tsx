import { useState } from "react";

// ─── Types ──────────────────────────────────────────────────────────────────

export type MainConditionType = "cart_value" | "cart_quantity" | "specific_product" | "cart_value_multiplier" | "pack_of_products";

interface MainConditionOption {
  id: MainConditionType;
  name: string;
  desc: string;
  /** Si es true, va en la sección "combinable"; si es false, "independiente" */
  combinable: boolean;
  /** SVG icon path for the option */
  icon: JSX.Element;
}

interface MainConditionModalProps {
  open: boolean;
  /** Currently selected condition type (can be pre-filled from template). */
  initialSelected: MainConditionType;
  onClose: () => void;
  onConfirm: (type: MainConditionType) => void;
}

// ─── Iconos ─────────────────────────────────────────────────────────────────

function ICartValue() {
  return (
    <svg viewBox="0 0 20 20" width="28" height="28" fill="currentColor">
      <path fillRule="evenodd" d="M5.5 3.5a2 2 0 0 0-2 2v3.75c0 .414.336.75.75.75h2v5.769a.85.85 0 0 0 1.433.618l1.442-1.357 1.611 1.516a.75.75 0 0 0 1.028 0l1.611-1.516 1.442 1.357a.85.85 0 0 0 1.433-.618v-10.269a2 2 0 0 0-2-2h-8.494l.005.017a2.02 2.02 0 0 0-.261-.017Zm-.5 2a.5.5 0 0 1 1 0v3h-1v-3Zm2.75-.48-.006-.02h6.506a.5.5 0 0 1 .5.5v8.764l-.69-.649a1 1 0 0 0-1.37 0l-1.44 1.355-1.44-1.355a1 1 0 0 0-1.37 0l-.69.65v-9.245Zm2 1.48a.75.75 0 0 0 0 1.5h3a.75.75 0 0 0 0-1.5h-3Zm-.75 3.75a.75.75 0 0 1 .75-.75h3a.75.75 0 0 1 0 1.5h-3a.75.75 0 0 1-.75-.75Z"/>
    </svg>
  );
}

function ICartQty() {
  return (
    <svg viewBox="0 0 20 20" width="28" height="28" fill="currentColor">
      <path d="M3.25 3a.75.75 0 0 0 0 1.5h1.612a.25.25 0 0 1 .248.22l1.04 8.737a1.75 1.75 0 0 0 1.738 1.543h6.362a.75.75 0 0 0 0-1.5h-6.362a.25.25 0 0 1-.248-.22l-.093-.78h6.35a2.75 2.75 0 0 0 2.743-2.54l.358-4.652a.75.75 0 0 0-1.496-.116l-.358 4.654a1.25 1.25 0 0 1-1.246 1.154h-6.53l-.768-6.457a1.75 1.75 0 0 0-1.738-1.543h-1.612Z"/>
      <path d="M12 9.25a.75.75 0 0 1-1.5 0v-3.69l-1.22 1.22a.75.75 0 0 1-1.06-1.06l2.5-2.5a.75.75 0 0 1 1.06 0l2.5 2.5a.75.75 0 0 1-1.06 1.06l-1.22-1.22v3.69Z"/>
      <path d="M10 17a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/>
      <path d="M15 17a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/>
    </svg>
  );
}

function ISpecificProduct() {
  return (
    <svg viewBox="0 0 20 20" width="28" height="28" fill="currentColor">
      <path d="M11.276 3.5a3.75 3.75 0 0 0-2.701 1.149l-4.254 4.417a2.75 2.75 0 0 0 .036 3.852l2.898 2.898a2.5 2.5 0 0 0 3.502.033l.45-.434a.75.75 0 1 0-1.04-1.08l-.45.434a1 1 0 0 1-1.401-.014l-2.898-2.898a1.25 1.25 0 0 1-.016-1.75l4.253-4.418a2.25 2.25 0 0 1 1.62-.689h1.975c.966 0 1.75.784 1.75 1.75v2.371c0 .358-.146.7-.403.948a.75.75 0 1 0 1.04 1.08 2.81 2.81 0 0 0 .863-2.028v-2.371a3.25 3.25 0 0 0-3.25-3.25h-1.974Z"/>
      <path d="M13 8a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"/>
      <path d="M14.75 12a.75.75 0 0 1 .75.75v1.25h1.25a.75.75 0 0 1 0 1.5h-1.25v1.25a.75.75 0 0 1-1.5 0v-1.25h-1.25a.75.75 0 0 1 0-1.5h1.25v-1.25a.75.75 0 0 1 .75-.75Z"/>
    </svg>
  );
}

function ICartMultiplier() {
  return (
    <svg viewBox="0 0 20 20" width="28" height="28" fill="currentColor">
      <path d="M7.75 5a.75.75 0 0 0 0 1.5h4.5a.75.75 0 1 0 0-1.5h-4.5Z"/>
      <path d="M7 8.75a.75.75 0 0 1 .75-.75h1.5a.75.75 0 0 1 0 1.5h-1.5a.75.75 0 0 1-.75-.75Z"/>
      <path d="M7.75 11a.75.75 0 0 0 0 1.5h1.5a.75.75 0 0 0 0-1.5h-1.5Z"/>
      <path d="M11 8.75a.75.75 0 0 1 .75-.75h.5a.75.75 0 0 1 0 1.5h-.5a.75.75 0 0 1-.75-.75Z"/>
      <path d="M11.75 11a.75.75 0 0 0 0 1.5h.5a.75.75 0 0 0 0-1.5h-.5Z"/>
      <path fillRule="evenodd" d="M4 16a1.5 1.5 0 0 0 2.615 1.003l1.135-1.26 1.135 1.26a1.5 1.5 0 0 0 2.23 0l1.135-1.26 1.135 1.26a1.5 1.5 0 0 0 2.615-1.003v-11a2.5 2.5 0 0 0-2.5-2.5h-7a2.5 2.5 0 0 0-2.5 2.5v11Zm2.5-12a1 1 0 0 0-1 1v11l1.507-1.674a1 1 0 0 1 1.486 0l1.507 1.674 1.507-1.674a1 1 0 0 1 1.486 0l1.507 1.674v-11a1 1 0 0 0-1-1h-7Z"/>
    </svg>
  );
}

function IPackOfProducts() {
  return (
    <svg viewBox="0 0 20 20" width="28" height="28" fill="currentColor">
      <path fillRule="evenodd" d="M7 9a1 1 0 0 0-1 1v3a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-4Zm.5 3.5v-2h3v2h-3Z"/>
      <path fillRule="evenodd" d="M5.315 4.45a2.25 2.25 0 0 1 1.836-.95h5.796a2.25 2.25 0 0 1 1.872 1.002l1.22 1.828c.3.452.461.983.461 1.526v6.894a1.75 1.75 0 0 1-1.75 1.75h-9.5a1.75 1.75 0 0 1-1.75-1.75v-6.863c0-.57.177-1.125.506-1.59l1.309-1.848Zm1.836.55a.75.75 0 0 0-.612.316l-.839 1.184h3.55v-1.5h-2.1Zm3.599 1.5h3.599l-.778-1.166a.75.75 0 0 0-.624-.334h-2.197v1.5Zm4.25 1.5h-10v6.75c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25v-6.75Z"/>
    </svg>
  );
}

// ─── Options ────────────────────────────────────────────────────────────────

const COMBINABLE_OPTIONS: MainConditionOption[] = [
  {
    id: "cart_value",
    name: "Condición del valor del carrito",
    desc: "Por ejemplo: Gasta $100 para recibir un regalo",
    combinable: true,
    icon: <ICartValue />,
  },
  {
    id: "cart_quantity",
    name: "Condición de cantidad del carrito",
    desc: "Por ejemplo: compre 5 productos para recibir un regalo",
    combinable: true,
    icon: <ICartQty />,
  },
];

const INDEPENDENT_OPTIONS: MainConditionOption[] = [
  {
    id: "specific_product",
    name: "Condición específica del producto",
    desc: "Por ejemplo: compre el producto A para obtener el regalo B",
    combinable: false,
    icon: <ISpecificProduct />,
  },
  {
    id: "cart_value_multiplier",
    name: "Condición del multiplicador del valor del carrito",
    desc: "Por ejemplo: Gaste $100 y obtenga un regalo, $200 y obtenga otro",
    combinable: false,
    icon: <ICartMultiplier />,
  },
  {
    id: "pack_of_products",
    name: "Paquete de productos",
    desc: "Por ejemplo: compre A y B para recibir un regalo",
    combinable: false,
    icon: <IPackOfProducts />,
  },
];

// ─── Component ──────────────────────────────────────────────────────────────

export function MainConditionModal({ open, initialSelected, onClose, onConfirm }: MainConditionModalProps) {
  const [selected, setSelected] = useState<MainConditionType | null>(initialSelected ?? null);

  if (!open) return null;

  function handleConfirm() {
    if (selected) onConfirm(selected);
    onClose();
  }

  return (
    <div className="b-modal-overlay" onClick={onClose} style={{ zIndex: 1000 }}>
      <div className="b-modal" style={{ maxWidth: 700, width: "90%" }} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={{ background: "var(--bg-hover)", borderBottom: "1px solid var(--border)", padding: "16px 24px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Agregar condición principal</h2>
          <button className="b-modal-close" onClick={onClose}>×</button>
        </div>

        {/* Body */}
        <div className="b-modal-body" style={{ padding: "20px 24px" }}>
          {/* Combinables */}
          <p style={{ fontSize: 14, color: "var(--text)", marginBottom: 14 }}>Condiciones combinables con otras.</p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20 }}>
            {COMBINABLE_OPTIONS.map((opt) => (
              <ConditionCard key={opt.id} opt={opt} selected={selected === opt.id} onSelect={() => setSelected(opt.id)} />
            ))}
          </div>

          <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "0 0 20px" }} />

          {/* Independientes */}
          <p style={{ fontSize: 14, color: "var(--text)", marginBottom: 14 }}>Condiciones que solo se pueden utilizar de forma independiente.</p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 8 }}>
            {INDEPENDENT_OPTIONS.map((opt) => (
              <ConditionCard
                key={opt.id}
                opt={opt}
                selected={selected === opt.id}
                onSelect={() => setSelected(opt.id)}
              />
            ))}
          </div>
        </div>

        {/* Footer */}
        <div style={{ borderTop: "1px solid var(--border)", padding: "14px 24px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div></div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="b-btn b-btn-secondary" onClick={onClose}>Cancelar</button>
            <button className="b-btn b-btn-dark" onClick={handleConfirm} disabled={!selected}>
              Añade esta condición
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Internal card ──────────────────────────────────────────────────────────

function ConditionCard({
  opt,
  selected,
  onSelect,
}: {
  opt: MainConditionOption;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      onClick={onSelect}
      style={{
        border: `2px solid ${selected ? "var(--blue)" : "var(--border)"}`,
        borderRadius: 10,
        background: selected ? "var(--blue-light)" : "var(--bg)",
        cursor: "pointer",
        padding: "20px 16px",
        textAlign: "center",
        position: "relative",
        transition: "border-color 0.15s, background 0.15s",
      }}
    >
      {/* Feature badge */}
      {opt.id === "cart_value_multiplier" && (
        <div style={{ position: "absolute", top: 0, right: 0, zIndex: 1, borderTopRightRadius: 10, overflow: "hidden" }}>
          <img src="data:image/svg+xml,%3csvg%20width='36'%20height='36'%20viewBox='0%200%2036%2036'%20fill='none'%20xmlns='http://www.w3.org/2000/svg'%3e%3cpath%20d='M0%200H36V36L0%200Z'%20fill='%23FFAA00'/%3e%3cpath%20d='M0%200H36V36L0%200Z'%20fill='url(%23paint0_linear_30409_40096)'%20fill-opacity='0.5'/%3e%3cpath%20d='M28.8775%2014.8774C28.8593%2013.9095%2028.481%2012.947%2027.7424%2012.2085L27.3396%2011.8057L25.8059%2013.3395L26.2087%2013.7422C26.8763%2014.4099%2026.8763%2015.492%2026.2088%2016.1596C25.5412%2016.8271%2024.459%2016.8272%2023.7913%2016.1596C23.1237%2015.4919%2023.1238%2014.4099%2023.7914%2013.7422L27.7425%209.79118C28.41%209.12371%2029.4922%209.12366%2030.1597%209.79118C30.8272%2010.4587%2030.8273%2011.541%2030.1598%2012.2085L31.6936%2013.7422C33.2082%2012.2277%2033.2081%209.77202%2031.6935%208.25743C31.2597%207.82368%2030.7489%207.51414%2030.2049%207.32882C29.7756%207.18258%2029.3261%207.11358%2028.8777%207.12222C28.8861%206.67385%2028.8172%206.22419%2028.6711%205.79503C28.4858%205.25118%2028.1762%204.74017%2027.7424%204.30632C26.2278%202.79173%2023.7722%202.79173%2022.2576%204.30632C21.8238%204.74017%2021.5143%205.25123%2021.3289%205.79502C21.1827%206.22428%2021.1138%206.67389%2021.1224%207.12232C20.674%207.11367%2020.2244%207.18258%2019.7951%207.32882C19.2513%207.51409%2018.7403%207.82362%2018.3065%208.25743C16.792%209.77201%2016.7919%2012.2277%2018.3064%2013.7422C18.7403%2014.1761%2019.2513%2014.4856%2019.7951%2014.6709C20.2243%2014.817%2020.6739%2014.8859%2021.1224%2014.8775C21.1138%2015.3259%2021.1827%2015.7755%2021.3289%2016.2047C21.5142%2016.7488%2021.8238%2017.2596%2022.2575%2017.6933C23.7721%2019.2079%2026.2279%2019.2079%2027.7425%2017.6934C28.1762%2017.2596%2028.4857%2016.7485%2028.6711%2016.2047C28.8173%2015.7755%2028.8861%2015.3257%2028.8775%2014.8774ZM22.2577%2012.2085C21.5901%2012.8761%2020.5079%2012.8761%2019.8403%2012.2085C19.1727%2011.5409%2019.1728%2010.4588%2019.8404%209.79118C20.508%209.12356%2021.5901%209.12365%2022.2576%209.79118L23.4663%2010.9999L22.2577%2012.2085ZM25.0001%209.46614L23.7913%208.25743C23.1239%207.58996%2023.1238%206.50774%2023.7914%205.84012C24.4591%205.1725%2025.5411%205.1726%2026.2087%205.84012C26.8762%206.50764%2026.8763%207.58991%2026.2088%208.25743L25.0001%209.46614Z'%20fill='white'/%3e%3cpath%20d='M21.1225%207.12289C21.1407%208.09071%2021.519%209.0532%2022.2576%209.79175L22.6604%2010.1945L24.1941%208.66079L23.7913%208.258C23.1237%207.59038%2023.1237%206.50822%2023.7912%205.84069C24.4588%205.17317%2025.541%205.17307%2026.2087%205.84069C26.8763%206.50832%2026.8762%207.59038%2026.2086%208.258L22.2575%2012.2091C21.59%2012.8765%2020.5078%2012.8766%2019.8403%2012.2091C19.1728%2011.5415%2019.1727%2010.4593%2019.8402%209.79175L18.3064%208.258C16.7918%209.77259%2016.7919%2012.2282%2018.3065%2013.7428C18.7403%2014.1766%2019.2511%2014.4861%2019.7951%2014.6714C20.2244%2014.8177%2020.6739%2014.8867%2021.1223%2014.878C21.1139%2015.3264%2021.1828%2015.7761%2021.3289%2016.2052C21.5142%2016.7491%2021.8238%2017.2601%2022.2576%2017.6939C23.7722%2019.2085%2026.2278%2019.2085%2027.7424%2017.6939C28.1762%2017.2601%2028.4857%2016.749%2028.6711%2016.2052C28.8173%2015.776%2028.8862%2015.3264%2028.8776%2014.8779C29.326%2014.8866%2029.7756%2014.8177%2030.2049%2014.6714C30.7487%2014.4862%2031.2597%2014.1766%2031.6935%2013.7428C33.208%2012.2282%2033.2081%209.77259%2031.6936%208.25801C31.2597%207.82415%2030.7487%207.51462%2030.2049%207.3293C29.7757%207.1832%2029.3261%207.1143%2028.8776%207.12279C28.8862%206.67437%2028.8173%206.22476%2028.6711%205.7955C28.4858%205.25145%2028.1762%204.74065%2027.7424%204.30689C26.2279%202.79231%2023.7721%202.79231%2022.2575%204.30689C21.8238%204.74065%2021.5143%205.2517%2021.3289%205.7955C21.1827%206.22476%2021.1139%206.67452%2021.1225%207.12289ZM27.7423%209.79175C28.4099%209.12413%2029.4921%209.12413%2030.1597%209.79175C30.8273%2010.4594%2030.8272%2011.5414%2030.1596%2012.2091C29.492%2012.8767%2028.4099%2012.8766%2027.7424%2012.2091L26.5337%2011.0004L27.7423%209.79175ZM24.9999%2012.5341L26.2087%2013.7428C26.8761%2014.4103%2026.8762%2015.4925%2026.2086%2016.1601C25.5409%2016.8277%2024.4589%2016.8276%2023.7913%2016.1601C23.1238%2015.4926%2023.1237%2014.4103%2023.7912%2013.7428L24.9999%2012.5341Z'%20fill='white'/%3e%3cdefs%3e%3clinearGradient%20id='paint0_linear_30409_40096'%20x1='18'%20y1='0'%20x2='18'%20y2='36'%20gradientUnits='userSpaceOnUse'%3e%3cstop%20stop-color='white'%20stop-opacity='0'/%3e%3cstop%20offset='1'%20stop-color='white'/%3e%3c/linearGradient%3e%3c/defs%3e%3c/svg%3e" width="36" height="36" alt="feature-plan" />
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "center", marginBottom: 8 }}>
        {opt.icon}
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>{opt.name}</div>
      <div style={{ fontSize: 12, color: "var(--text-sub)", lineHeight: 1.4 }}>{opt.desc}</div>
    </div>
  );
}
