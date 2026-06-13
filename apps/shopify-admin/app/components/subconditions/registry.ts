import type { ComponentType } from "react";
import type { SubconditionId } from "./types.js";
import type { SubFormProps } from "./forms.js";
import {
  CustomerTagsForm,
  LinkForm,
  LocationForm,
  MarketsForm,
  OrderHistoryForm,
  QuantityLimitForm,
  SalesChannelForm,
  SubscriptionForm,
} from "./forms.js";

export const SUB_FORMS: Record<SubconditionId, ComponentType<SubFormProps>> = {
  link: LinkForm,
  order_history: OrderHistoryForm,
  customer_tags: CustomerTagsForm,
  location: LocationForm,
  subscription: SubscriptionForm,
  sales_channel: SalesChannelForm,
  markets: MarketsForm,
  quantity_limit: QuantityLimitForm,
};
