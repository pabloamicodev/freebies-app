/**
 * React hooks for the Promo Engine headless SDK.
 * Works with React 18+ in Hydrogen, Next.js, or any React storefront.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { EvaluationResult } from "@promo/shared-types";
import type { PromoEngineClient, EvaluateOptions } from "../client.js";

export interface UsePromoOffersOptions extends EvaluateOptions {
  client: PromoEngineClient;
  /** Debounce delay in ms. Default: 300. */
  debounceMs?: number;
  enabled?: boolean;
}

export interface UsePromoOffersResult {
  data: EvaluationResult | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * Hook to evaluate promo offers for the current cart.
 * Re-evaluates when cart changes (debounced).
 *
 * @example
 * ```tsx
 * const { data, loading } = usePromoOffers({
 *   client: promoClient,
 *   cart: { lines: cart.lines, currencyCode: "USD" },
 *   customer: customer ? { id: customer.id, tags: customer.tags } : undefined,
 * });
 *
 * if (data?.giftSlider) {
 *   return <GiftSlider payload={data.giftSlider} />;
 * }
 * ```
 */
export function usePromoOffers(options: UsePromoOffersOptions): UsePromoOffersResult {
  const { client, debounceMs = 300, enabled = true, ...evaluateOptions } = options;
  const [data, setData] = useState<EvaluationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const evaluate = useCallback(async () => {
    if (!enabled) return;

    // Cancel previous request
    abortRef.current?.abort();
    abortRef.current = new AbortController();

    setLoading(true);
    setError(null);

    try {
      const result = await client.evaluate(evaluateOptions);
      setData(result);
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setError(e as Error);
      }
    } finally {
      setLoading(false);
    }
  }, [client, JSON.stringify(evaluateOptions), enabled]);

  // Debounce evaluation when cart changes
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(evaluate, debounceMs);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      abortRef.current?.abort();
    };
  }, [evaluate, debounceMs]);

  return { data, loading, error, refetch: evaluate };
}

/**
 * Hook to track analytics events via the promo engine.
 */
export function usePromoTrack(client: PromoEngineClient) {
  return useCallback(
    (eventName: string, payload: Record<string, unknown>) => {
      void client.track(eventName, payload);
    },
    [client],
  );
}
