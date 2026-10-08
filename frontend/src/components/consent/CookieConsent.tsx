"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useConsent } from "@/hooks/useConsent";
import {
  ALL_ACCEPTED,
  ALL_REFUSED,
  CONSENT_OPEN_EVENT,
  VISIBLE_CATEGORIES,
  saveConsent,
  type ConsentCategory,
  type ConsentChoices,
} from "@/lib/consent";

const OPTIONAL_CATEGORIES = (Object.keys(VISIBLE_CATEGORIES) as ConsentCategory[]).filter(
  (category) => VISIBLE_CATEGORIES[category],
);

const buttonBase =
  "inline-flex h-10 items-center justify-center rounded-lg px-4 text-sm font-medium transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2";
const primaryButton = cn(buttonBase, "bg-green-700 text-white hover:bg-green-800");
const secondaryButton = cn(buttonBase, "border border-gray-300 bg-white text-gray-900 hover:bg-gray-50");

/**
 * First-visit banner + preferences panel. Optional categories stay off until
 * the visitor turns them on; refusing is as easy as accepting.
 */
export default function CookieConsent() {
  const { t } = useTranslation();
  const { consent, ready } = useConsent();
  const [panelOpen, setPanelOpen] = useState(false);
  const [draft, setDraft] = useState<ConsentChoices>(ALL_REFUSED);

  // The panel starts from the current choices (or everything off).
  const openPanel = useCallback(() => {
    setDraft(consent?.choices ?? ALL_REFUSED);
    setPanelOpen(true);
  }, [consent]);

  // Footer link (and any other "cookie preferences" entry point) reopens it.
  useEffect(() => {
    window.addEventListener(CONSENT_OPEN_EVENT, openPanel);
    return () => window.removeEventListener(CONSENT_OPEN_EVENT, openPanel);
  }, [openPanel]);

  const decide = (choices: ConsentChoices) => {
    saveConsent(choices);
    setPanelOpen(false);
  };

  const showBanner = ready && consent === null && !panelOpen;

  return (
    <>
      {showBanner && (
        <section
          role="region"
          aria-label={t("cookieConsent.title")}
          className="fixed inset-x-3 bottom-3 z-[60] rounded-xl border border-gray-200 bg-white p-4 shadow-xl sm:inset-x-auto sm:left-4 sm:bottom-4 sm:max-w-md sm:p-5"
        >
          <h2 className="text-base font-semibold text-gray-900">{t("cookieConsent.title")}</h2>
          <p className="mt-1.5 text-sm leading-relaxed text-gray-600">
            {t("cookieConsent.body")}{" "}
            <Link href="/privacy-policy" className="font-medium text-green-700 underline underline-offset-2 hover:text-green-800">
              {t("cookieConsent.privacyLink")}
            </Link>
          </p>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button type="button" className={secondaryButton} onClick={() => decide(ALL_REFUSED)}>
              {t("cookieConsent.refuseAll")}
            </button>
            <button type="button" className={primaryButton} onClick={() => decide(ALL_ACCEPTED)}>
              {t("cookieConsent.acceptAll")}
            </button>
          </div>
          <button
            type="button"
            className="mt-2 w-full cursor-pointer rounded-lg py-1.5 text-sm font-medium text-gray-700 underline-offset-2 hover:underline"
            onClick={openPanel}
          >
            {t("cookieConsent.customize")}
          </button>
        </section>
      )}

      <Dialog open={panelOpen} onOpenChange={setPanelOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("cookieConsent.preferencesTitle")}</DialogTitle>
            <DialogDescription>{t("cookieConsent.preferencesIntro")}</DialogDescription>
          </DialogHeader>

          <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200">
            <li className="flex items-start justify-between gap-4 p-4">
              <div>
                <p className="text-sm font-semibold text-gray-900">{t("cookieConsent.categories.necessary.title")}</p>
                <p className="mt-1 text-sm text-gray-600">{t("cookieConsent.categories.necessary.description")}</p>
              </div>
              <span className="shrink-0 pt-0.5 text-xs font-medium text-green-700">{t("cookieConsent.alwaysOn")}</span>
            </li>
            {OPTIONAL_CATEGORIES.map((category) => (
              <li key={category} className="flex items-start justify-between gap-4 p-4">
                <label htmlFor={`consent-${category}`} className="cursor-pointer">
                  <span className="block text-sm font-semibold text-gray-900">
                    {t(`cookieConsent.categories.${category}.title`)}
                  </span>
                  <span className="mt-1 block text-sm text-gray-600">
                    {t(`cookieConsent.categories.${category}.description`)}
                  </span>
                </label>
                <Switch
                  id={`consent-${category}`}
                  checked={draft[category]}
                  onCheckedChange={(checked) => setDraft((prev) => ({ ...prev, [category]: checked }))}
                  className="mt-0.5 data-[state=checked]:bg-green-700"
                />
              </li>
            ))}
          </ul>

          <DialogFooter className="grid grid-cols-1 gap-2 sm:grid-cols-3 sm:space-x-0">
            <button type="button" className={secondaryButton} onClick={() => decide(ALL_REFUSED)}>
              {t("cookieConsent.refuseAll")}
            </button>
            <button type="button" className={secondaryButton} onClick={() => decide(draft)}>
              {t("cookieConsent.save")}
            </button>
            <button type="button" className={primaryButton} onClick={() => decide(ALL_ACCEPTED)}>
              {t("cookieConsent.acceptAll")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
