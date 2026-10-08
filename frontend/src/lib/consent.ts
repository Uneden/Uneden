/**
 * Cookie / tracking consent (Québec Law 25: anything beyond what the site
 * needs to work stays off until the visitor opts in).
 *
 * Adding a category or a new tool inside one: add it below, bump
 * CONSENT_VERSION so everyone is asked again, and gate the tool with
 * useConsent() / hasConsent().
 */

export const CONSENT_VERSION = 1;

export type ConsentCategory = "statistics" | "sessionReplay" | "advertising";

/**
 * Categories shown to visitors. Advertising (Google AdSense) exists in the
 * model but stays hidden while no ad is served: set it to true when AdSense
 * goes live, and bump CONSENT_VERSION.
 */
export const VISIBLE_CATEGORIES: Record<ConsentCategory, boolean> = {
  statistics: true,
  sessionReplay: true,
  advertising: false,
};

export type ConsentChoices = Record<ConsentCategory, boolean>;

export interface StoredConsent {
  version: number;
  choices: ConsentChoices;
  decidedAt: string;
}

export const ALL_REFUSED: ConsentChoices = { statistics: false, sessionReplay: false, advertising: false };

/** Accepting all only grants the categories visitors can actually see. */
export const ALL_ACCEPTED: ConsentChoices = { ...VISIBLE_CATEGORIES };

export const CONSENT_STORAGE_KEY = "uneden-consent";
export const CONSENT_CHANGED_EVENT = "uneden:consent-changed";
export const CONSENT_OPEN_EVENT = "uneden:consent-open";

/** The visitor's current decision, or null when they must be asked (none yet, or an older version). */
export function readConsent(): StoredConsent | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CONSENT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredConsent;
    if (parsed?.version !== CONSENT_VERSION || typeof parsed.choices !== "object") return null;
    return {
      ...parsed,
      // Anything missing or hidden counts as refused.
      choices: {
        statistics: parsed.choices.statistics === true && VISIBLE_CATEGORIES.statistics,
        sessionReplay: parsed.choices.sessionReplay === true && VISIBLE_CATEGORIES.sessionReplay,
        advertising: parsed.choices.advertising === true && VISIBLE_CATEGORIES.advertising,
      },
    };
  } catch {
    return null;
  }
}

export function saveConsent(choices: ConsentChoices): StoredConsent {
  const consent: StoredConsent = {
    version: CONSENT_VERSION,
    choices: {
      statistics: choices.statistics && VISIBLE_CATEGORIES.statistics,
      sessionReplay: choices.sessionReplay && VISIBLE_CATEGORIES.sessionReplay,
      advertising: choices.advertising && VISIBLE_CATEGORIES.advertising,
    },
    decidedAt: new Date().toISOString(),
  };
  try {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(consent));
  } catch {
    // Private mode / blocked storage: the choice applies to this page view only.
  }
  window.dispatchEvent(new CustomEvent(CONSENT_CHANGED_EVENT, { detail: consent }));
  return consent;
}

export function hasConsent(category: ConsentCategory): boolean {
  return readConsent()?.choices[category] === true;
}

/** Reopens the preferences panel (footer link, privacy policy…). */
export function openConsentPreferences(): void {
  window.dispatchEvent(new Event(CONSENT_OPEN_EVENT));
}
