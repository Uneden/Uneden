"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslation } from "react-i18next";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { getLanguageToggleValue } from "@/lib/locale";
import { cn } from "@/lib/utils";
import { openConsentPreferences } from "@/lib/consent";

const FLUSH_FOOTER_ROUTES = [
  "/help",
  "/about",
  "/contact",
  "/privacy-policy",
  "/terms",
  "/payment-terms",
  "/trust-safety",
];

export default function Footer() {
  const { t, i18n } = useTranslation();
  const pathname = usePathname();
  const flushFooter = FLUSH_FOOTER_ROUTES.some((r) => pathname.startsWith(r));

  return (
    <footer
      className={cn(
        "border-t border-green-800 bg-green-900 text-gray-300",
        flushFooter ? "mt-0" : "mt-20",
      )}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-10">

        {/* Rangée principale */}
        <div className="flex flex-col items-center sm:flex-row sm:items-center sm:justify-between gap-6">

          {/* Logo */}
          <div className="text-center sm:text-left">
            <Link href="/" className="inline-block outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-green-900 rounded-sm">
              <h1 className="text-2xl font-bold text-white cursor-pointer hover:opacity-90 transition-opacity">
                Uneden
              </h1>
            </Link>
          </div>

          {/* Nav links */}
          <nav className="flex flex-wrap justify-center sm:justify-start gap-x-4 gap-y-2 text-xs font-medium">
            <a href="/about" className="whitespace-nowrap hover:text-white transition-colors cursor-pointer">{t("footer.about")}</a>
            <a href="/help" className="whitespace-nowrap hover:text-white transition-colors cursor-pointer">{t("footer.help")}</a>
            <a href="/contact" className="whitespace-nowrap hover:text-white transition-colors cursor-pointer">{t("footer.contact")}</a>
            <a href="/privacy-policy" className="whitespace-nowrap hover:text-white transition-colors cursor-pointer">{t("footer.privacyPolicy")}</a>
            <a href="/terms" className="whitespace-nowrap hover:text-white transition-colors cursor-pointer">{t("footer.termsOfUse")}</a>
            <a href="/payment-terms" className="whitespace-nowrap hover:text-white transition-colors cursor-pointer">{t("footer.paymentTerms")}</a>
            <a href="/trust-safety" className="whitespace-nowrap hover:text-white transition-colors cursor-pointer">{t("footer.trustSafety")}</a>
            <button type="button" onClick={openConsentPreferences} className="whitespace-nowrap hover:text-white transition-colors cursor-pointer">{t("footer.cookiePreferences")}</button>
          </nav>

          {/* Toggle langue */}
          <ToggleGroup
            type="single"
            variant="outline"
            className="border-green-700"
            value={getLanguageToggleValue(i18n.language)}
            onValueChange={(val) => { if (val) { const lng = val.toLowerCase(); i18n.changeLanguage(lng); localStorage.setItem("i18nextLng", lng); } }}
          >
            <ToggleGroupItem value="FR" className="cursor-pointer text-sm px-3 h-8 text-white border-green-700 hover:bg-green-800">FR</ToggleGroupItem>
            <ToggleGroupItem value="EN" className="cursor-pointer text-sm px-3 h-8 text-white border-green-700 hover:bg-green-800">EN</ToggleGroupItem>
          </ToggleGroup>

        </div>

        {/* Séparateur */}
        <div className="border-t border-green-800 mt-8 pt-5 text-center">
          <p className="text-xs text-white">
            {t("footer.rights", { year: new Date().getFullYear() })}
          </p>
        </div>

      </div>
    </footer>
  );
}
