import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALL_ACCEPTED,
  ALL_REFUSED,
  CONSENT_CHANGED_EVENT,
  CONSENT_OPEN_EVENT,
  CONSENT_STORAGE_KEY,
  CONSENT_VERSION,
  hasConsent,
  openConsentPreferences,
  readConsent,
  saveConsent,
} from "./consent";

describe("consent", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("asks first: nothing stored means no consent and every optional tool off", () => {
    expect(readConsent()).toBeNull();
    expect(hasConsent("statistics")).toBe(false);
    expect(hasConsent("sessionReplay")).toBe(false);
  });

  it("remembers an acceptance", () => {
    saveConsent(ALL_ACCEPTED);
    expect(hasConsent("statistics")).toBe(true);
    expect(hasConsent("sessionReplay")).toBe(true);
    expect(readConsent()?.version).toBe(CONSENT_VERSION);
  });

  it("remembers a refusal (the banner must not come back)", () => {
    saveConsent(ALL_REFUSED);
    expect(readConsent()).not.toBeNull();
    expect(hasConsent("statistics")).toBe(false);
  });

  it("keeps a partial choice", () => {
    saveConsent({ statistics: true, sessionReplay: false, advertising: false });
    expect(hasConsent("statistics")).toBe(true);
    expect(hasConsent("sessionReplay")).toBe(false);
  });

  it("never grants advertising while that category is hidden", () => {
    saveConsent({ statistics: true, sessionReplay: true, advertising: true });
    expect(hasConsent("advertising")).toBe(false);
    expect(ALL_ACCEPTED.advertising).toBe(false);
  });

  it("asks again after the categories change (older version)", () => {
    localStorage.setItem(
      CONSENT_STORAGE_KEY,
      JSON.stringify({ version: CONSENT_VERSION - 1, choices: ALL_ACCEPTED, decidedAt: "2026-01-01" }),
    );
    expect(readConsent()).toBeNull();
  });

  it("treats a corrupted value as no decision", () => {
    localStorage.setItem(CONSENT_STORAGE_KEY, "{not json");
    expect(readConsent()).toBeNull();
  });

  it("announces the decision, even when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const listener = vi.fn();
    window.addEventListener(CONSENT_CHANGED_EVENT, listener);
    expect(() => saveConsent(ALL_ACCEPTED)).not.toThrow();
    expect((listener.mock.calls[0][0] as CustomEvent).detail.choices.statistics).toBe(true);
    window.removeEventListener(CONSENT_CHANGED_EVENT, listener);
  });

  it("lets the footer reopen the preferences", () => {
    const listener = vi.fn();
    window.addEventListener(CONSENT_OPEN_EVENT, listener);
    openConsentPreferences();
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(CONSENT_OPEN_EVENT, listener);
  });
});
