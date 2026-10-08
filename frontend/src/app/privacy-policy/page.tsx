"use client";
import { Trans, useTranslation } from "react-i18next";
import LegalSidebarNav from "@/components/legal/LegalSidebarNav";
import { openConsentPreferences } from "@/lib/consent";

export default function PrivacyPolicyPage() {
  const { t } = useTranslation();

  const sections = [
    { id: "info-collect", label: t("privacyPolicyPage.sections.infoCollect.title") },
    { id: "how-use", label: t("privacyPolicyPage.sections.howUse.title") },
    { id: "sharing", label: t("privacyPolicyPage.sections.sharing.title") },
    { id: "emails", label: t("privacyPolicyPage.sections.emails.title") },
    { id: "storage", label: t("privacyPolicyPage.sections.storage.title") },
    { id: "location", label: t("privacyPolicyPage.sections.location.title") },
    { id: "third-party", label: t("privacyPolicyPage.sections.thirdParty.title") },
    { id: "rights", label: t("privacyPolicyPage.sections.rights.title") },
    { id: "changes", label: t("privacyPolicyPage.sections.changes.title") },
    { id: "contact", label: t("privacyPolicyPage.sections.contact.title") },
  ];

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">

      <div className="grid gap-10 lg:grid-cols-[16rem_1px_minmax(0,1fr)] lg:items-start">
        <LegalSidebarNav sections={sections} onNavigate={scrollTo} />

        <div className="hidden self-stretch bg-gray-200 lg:block" aria-hidden="true" />

        <div>
          {/* Header */}
          <div className="mb-10">
        <h1 className="text-4xl font-bold text-gray-900 mb-3">
          {t("privacyPolicyPage.title")}
        </h1>
        <p className="text-gray-500 text-sm">{t("privacyPolicyPage.lastUpdatedLabel")}<span className="font-semibold text-gray-900">{t("privacyPolicyPage.lastUpdatedValue")}</span></p>
        <p className="mt-4 text-gray-600 leading-relaxed">
          <Trans i18nKey="privacyPolicyPage.intro" components={{ strong: <span className="font-semibold text-gray-900" /> }} />
        </p>
          </div>

          {/* Sections */}
          <div className="space-y-12 text-gray-700 text-sm leading-relaxed">

        <section id="info-collect">
          <h2 className="text-xl font-bold text-gray-900 mb-4">
            {t("privacyPolicyPage.sections.infoCollect.title")}
          </h2>
          <p className="mb-4">{t("privacyPolicyPage.sections.infoCollect.intro")}</p>
          <div className="space-y-5">
            <div>
              <h3 className="font-semibold text-gray-800 mb-2">{t("privacyPolicyPage.sections.infoCollect.personalInfoTitle")}</h3>
              <ul className="list-disc list-inside space-y-1 text-gray-600 ml-2">
                {(t("privacyPolicyPage.sections.infoCollect.personalInfoItems", { returnObjects: true }) as string[]).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="font-semibold text-gray-800 mb-2">{t("privacyPolicyPage.sections.infoCollect.accountDataTitle")}</h3>
              <ul className="list-disc list-inside space-y-1 text-gray-600 ml-2">
                {(t("privacyPolicyPage.sections.infoCollect.accountDataItems", { returnObjects: true }) as string[]).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="font-semibold text-gray-800 mb-2">{t("privacyPolicyPage.sections.infoCollect.transactionDataTitle")}</h3>
              <ul className="list-disc list-inside space-y-1 text-gray-600 ml-2">
                {(t("privacyPolicyPage.sections.infoCollect.transactionDataItems", { returnObjects: true }) as string[]).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="font-semibold text-gray-800 mb-2">{t("privacyPolicyPage.sections.infoCollect.usageDataTitle")}</h3>
              <ul className="list-disc list-inside space-y-1 text-gray-600 ml-2">
                {(t("privacyPolicyPage.sections.infoCollect.usageDataItems", { returnObjects: true }) as string[]).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="font-semibold text-gray-800 mb-2">{t("privacyPolicyPage.sections.infoCollect.cookiesTitle")}</h3>
              <p className="mb-2">{t("privacyPolicyPage.sections.infoCollect.cookiesIntro")}</p>
              <ul className="list-disc list-inside space-y-1 text-gray-600 ml-2">
                {(t("privacyPolicyPage.sections.infoCollect.cookiesItems", { returnObjects: true }) as string[]).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <button
                type="button"
                onClick={openConsentPreferences}
                className="mt-3 cursor-pointer rounded-lg border border-green-700 px-3 py-1.5 text-sm font-medium text-green-700 transition-colors hover:bg-green-50"
              >
                {t("privacyPolicyPage.sections.infoCollect.cookiesManage")}
              </button>
            </div>
          </div>
        </section>

        <section id="how-use">
          <h2 className="text-xl font-bold text-gray-900 mb-4">
            {t("privacyPolicyPage.sections.howUse.title")}
          </h2>
          <p className="mb-3">{t("privacyPolicyPage.sections.howUse.intro")}</p>
          <ul className="list-disc list-inside space-y-2 text-gray-600 ml-2">
            {(t("privacyPolicyPage.sections.howUse.items", { returnObjects: true }) as string[]).map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>

        <section id="sharing">
          <h2 className="text-xl font-bold text-gray-900 mb-4">
            {t("privacyPolicyPage.sections.sharing.title")}
          </h2>
          <p className="mb-3">{t("privacyPolicyPage.sections.sharing.intro")}</p>
          <ul className="list-disc list-inside space-y-2 text-gray-600 ml-2">
            {(t("privacyPolicyPage.sections.sharing.items", { returnObjects: true }) as string[]).map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p className="mt-3"><Trans i18nKey="privacyPolicyPage.sections.sharing.note" components={{ strong: <span className="font-semibold text-gray-900" /> }} /></p>
        </section>

        <section id="emails">
          <h2 className="text-xl font-bold text-gray-900 mb-4">
            {t("privacyPolicyPage.sections.emails.title")}
          </h2>
          <p className="mb-3">{t("privacyPolicyPage.sections.emails.intro")}</p>
          <ul className="list-disc list-inside space-y-2 text-gray-600 ml-2">
            {(t("privacyPolicyPage.sections.emails.items", { returnObjects: true }) as string[]).map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p className="mt-3"><Trans i18nKey="privacyPolicyPage.sections.emails.note" components={{ strong: <span className="font-semibold text-gray-900" /> }} /></p>
        </section>

        <section id="storage">
          <h2 className="text-xl font-bold text-gray-900 mb-4">
            {t("privacyPolicyPage.sections.storage.title")}
          </h2>
          <p className="mb-3">{t("privacyPolicyPage.sections.storage.intro")}</p>
          <ul className="list-disc list-inside space-y-2 text-gray-600 ml-2">
            <li><Trans i18nKey="privacyPolicyPage.sections.storage.itemOne" components={{ strong: <span className="font-semibold text-gray-900" /> }} /></li>
            <li><Trans i18nKey="privacyPolicyPage.sections.storage.itemTwo" components={{ strong: <span className="font-semibold text-gray-900" /> }} /></li>
          </ul>
          <p className="mt-3"><Trans i18nKey="privacyPolicyPage.sections.storage.note" components={{ strong: <span className="font-semibold text-gray-900" /> }} /></p>
        </section>

        <section id="location">
          <h2 className="text-xl font-bold text-gray-900 mb-4">
            {t("privacyPolicyPage.sections.location.title")}
          </h2>
          <p className="mb-3">{t("privacyPolicyPage.sections.location.intro")}</p>
          <ul className="list-disc list-inside space-y-2 text-gray-600 ml-2">
            {(t("privacyPolicyPage.sections.location.items", { returnObjects: true }) as string[]).map((item) => (
              <li key={item}><span className="font-semibold text-gray-900">{item}</span></li>
            ))}
          </ul>
          <p className="mt-3">{t("privacyPolicyPage.sections.location.note")}</p>
        </section>

        <section id="third-party">
          <h2 className="text-xl font-bold text-gray-900 mb-4">
            {t("privacyPolicyPage.sections.thirdParty.title")}
          </h2>
          <p className="mb-3">{t("privacyPolicyPage.sections.thirdParty.intro")}</p>
          <ul className="list-disc list-inside space-y-2 text-gray-600 ml-2">
            {(t("privacyPolicyPage.sections.thirdParty.items", { returnObjects: true }) as string[]).map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p className="mt-3"><Trans i18nKey="privacyPolicyPage.sections.thirdParty.note" components={{ strong: <span className="font-semibold text-gray-900" /> }} /></p>
        </section>

        <section id="rights">
          <h2 className="text-xl font-bold text-gray-900 mb-4">
            {t("privacyPolicyPage.sections.rights.title")}
          </h2>
          <p className="mb-3">{t("privacyPolicyPage.sections.rights.intro")}</p>
          <ul className="list-disc list-inside space-y-2 text-gray-600 ml-2">
            {(t("privacyPolicyPage.sections.rights.items", { returnObjects: true }) as string[]).map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p className="mt-3"><Trans i18nKey="privacyPolicyPage.sections.rights.note" components={{ strong: <span className="font-semibold text-gray-900" /> }} /></p>
        </section>

        <section id="changes">
          <h2 className="text-xl font-bold text-gray-900 mb-4">
            {t("privacyPolicyPage.sections.changes.title")}
          </h2>
          <p>
            <Trans i18nKey="privacyPolicyPage.sections.changes.paragraph" components={{ strong: <span className="font-semibold text-gray-900" /> }} />
          </p>
        </section>

        <section id="contact">
          <h2 className="text-xl font-bold text-gray-900 mb-4">
            {t("privacyPolicyPage.sections.contact.title")}
          </h2>
          <p className="mb-3">{t("privacyPolicyPage.sections.contact.intro")}</p>
          <p>
            <a href="mailto:support@uneden.ca" className="text-green-700 hover:underline font-medium">
              {t("footer.supportEmail")}
            </a>
          </p>
        </section>

          </div>
        </div>
      </div>
    </div>
  );
}
