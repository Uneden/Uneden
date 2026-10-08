"use client";

import { useSyncExternalStore } from "react";
import {
  CONSENT_CHANGED_EVENT,
  CONSENT_STORAGE_KEY,
  readConsent,
  type StoredConsent,
} from "@/lib/consent";

// Snapshot cached by the raw stored value: useSyncExternalStore needs the
// same object back while nothing changed.
let cachedRaw: string | null | undefined;
let cachedConsent: StoredConsent | null = null;
// Last decision of this page view, for browsers where storage is blocked.
let sessionDecision: StoredConsent | null = null;

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(CONSENT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function getSnapshot(): StoredConsent | null {
  const raw = readRaw();
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedConsent = readConsent();
  }
  return cachedConsent ?? sessionDecision;
}

function subscribe(onChange: () => void): () => void {
  const onDecision = (event: Event) => {
    sessionDecision = (event as CustomEvent<StoredConsent>).detail ?? null;
    onChange();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === CONSENT_STORAGE_KEY) onChange();
  };
  window.addEventListener(CONSENT_CHANGED_EVENT, onDecision);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CONSENT_CHANGED_EVENT, onDecision);
    window.removeEventListener("storage", onStorage);
  };
}

const noopSubscribe = () => () => {};

/**
 * The visitor's consent, kept in sync with the banner, the preferences panel
 * and other tabs. `ready` is false during server rendering and hydration
 * (the server can't know the choice): render nothing optional before that.
 */
export function useConsent(): { consent: StoredConsent | null; ready: boolean } {
  const consent = useSyncExternalStore(subscribe, getSnapshot, () => null);
  const ready = useSyncExternalStore(noopSubscribe, () => true, () => false);
  return { consent, ready };
}
