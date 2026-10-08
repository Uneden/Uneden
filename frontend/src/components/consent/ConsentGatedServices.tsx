"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { useConsent } from "@/hooks/useConsent";

let replayStarted = false;

/**
 * Optional tools, loaded only with the visitor's consent. Error monitoring
 * (Sentry without replay, no personal data) is part of running the site and
 * stays on; see instrumentation-client.ts.
 */
export default function ConsentGatedServices() {
  const { consent, ready } = useConsent();
  const statistics = consent?.choices.statistics === true;
  const sessionReplay = consent?.choices.sessionReplay === true;

  useEffect(() => {
    if (!ready) return;
    if (sessionReplay && !replayStarted) {
      // Uses the replay sample rates set in Sentry.init.
      Sentry.addIntegration(Sentry.replayIntegration());
      replayStarted = true;
    } else if (!sessionReplay && replayStarted) {
      // Consent withdrawn: stop now. Accepting again resumes on the next page load.
      void Sentry.getReplay()?.stop();
    }
  }, [ready, sessionReplay]);

  if (!statistics) return null;
  return (
    <>
      <SpeedInsights />
      <Analytics />
    </>
  );
}
