import { useCallback, useReducer } from "react";
import type { Dispatch, SetStateAction } from "react";

type FieldAction<T extends object> = {
  [K in keyof T]: { key: K; value: SetStateAction<T[K]> };
}[keyof T];

function objectStateReducer<T extends object>(state: T, action: FieldAction<T>): T {
  const current = state[action.key];
  const next = typeof action.value === "function"
    ? (action.value as (previous: typeof current) => typeof current)(current)
    : action.value;

  if (Object.is(current, next)) return state;
  return { ...state, [action.key]: next };
}

function initObjectState<T extends object>(initial: T | (() => T)): T {
  return typeof initial === "function" ? (initial as () => T)() : initial;
}

export type ObjectFieldSetter<T extends object> = <K extends keyof T>(
  key: K,
  value: SetStateAction<T[K]>,
) => void;

export function useObjectState<T extends object>(initial: T | (() => T)) {
  const [state, dispatch] = useReducer(objectStateReducer<T>, initial, initObjectState);
  const setField = useCallback<ObjectFieldSetter<T>>((key, value) => {
    dispatch({ key, value } as FieldAction<T>);
  }, []);

  return [state, setField] as const;
}

export function createFieldSetter<T extends object, K extends keyof T>(
  setField: ObjectFieldSetter<T>,
  key: K,
): Dispatch<SetStateAction<T[K]>> {
  return (value) => setField(key, value);
}
