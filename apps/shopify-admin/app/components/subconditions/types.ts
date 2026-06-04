// ─── Subcondition type definitions ───────────────────────────────────────────
// Add new subcondition IDs here as the product grows.

export type SubconditionId =
  | "link"
  | "order_history"
  | "customer_tags"
  | "location"
  | "subscription"
  | "sales_channel"
  | "markets"
  | "quantity_limit";

export interface SubconditionDef {
  id: SubconditionId;
  name: string;
  desc: string;
  plus: boolean;
}

// ─── Offer-type specific sets ─────────────────────────────────────────────────
// Each offer type can expose all or a subset of subconditions.

export const ALL_SUBCONDITIONS: SubconditionDef[] = [
  {
    id: "link",
    name: "Dirección de enlace específica",
    desc: "Los clientes recibirán regalos si acceden a través de un enlace especial",
    plus: false,
  },
  {
    id: "order_history",
    name: "Historial de pedidos de los clientes",
    desc: "Los clientes deben cumplir con los requisitos del historial de pedidos.",
    plus: false,
  },
  {
    id: "customer_tags",
    name: "Etiquetas de clientes",
    desc: "Los clientes solo pueden recibir regalos si tienen la etiqueta de cliente correcta",
    plus: false,
  },
  {
    id: "location",
    name: "Ubicación del cliente",
    desc: "Los clientes solo pueden recibir regalos si son de países específicos.",
    plus: false,
  },
  {
    id: "subscription",
    name: "Productos de suscripción",
    desc: "Condición con productos de suscripción.",
    plus: true,
  },
  {
    id: "sales_channel",
    name: "Canales de ventas",
    desc: "Condición para la compra de clientes de la aplicación móvil, el canal de venta de POS",
    plus: true,
  },
  {
    id: "markets",
    name: "Mercados",
    desc: "Condición por mercados de Shopify para segmentar por región.",
    plus: true,
  },
  {
    id: "quantity_limit",
    name: "Límites de cantidad de productos",
    desc: "Limita el regalo según la cantidad de productos específicos en el carrito.",
    plus: true,
  },
];

// Convenience: gift and discount offers use the full set.
// Bundle / upsell can narrow this down if needed.
export const GIFT_SUBCONDITIONS = ALL_SUBCONDITIONS;
export const DISCOUNT_SUBCONDITIONS = ALL_SUBCONDITIONS;
export const BUNDLE_SUBCONDITIONS = ALL_SUBCONDITIONS;
export const UPSELL_SUBCONDITIONS = ALL_SUBCONDITIONS;
