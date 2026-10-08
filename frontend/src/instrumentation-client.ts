// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: "https://7cd85ab49bc4314b86bbc83a5215c87d@o4511106103640064.ingest.us.sentry.io/4511106105540608",

  // No telemetry in dev — avoids noisy "/monitoring" proxy errors (ECONNRESET) in the terminal.
  enabled: process.env.NODE_ENV === "production",

  // Session Replay records what visitors do: it is only added once they
  // consent (components/consent/ConsentGatedServices.tsx). These rates apply
  // from then on.
  tracesSampleRate: 0.1,
  enableLogs: true,
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
  // Error monitoring runs without consent, so it must not collect personal
  // data (IP address, cookies, headers).
  sendDefaultPii: false,

  beforeSend(event, hint) {
    const error = hint?.originalException;
    const msg = typeof error === "string" ? error : (error as Error)?.message ?? "";

    // Filter browser extension noise (LastPass, Grammarly, Dashlane, etc.)
    if (msg.includes("Object Not Found Matching Id")) return null;

    // Filter expected health check failures during backend cold start
    const url = (event.request?.url ?? "");
    if (url.includes("/api/health")) return null;

    // Filter non-Error unhandled rejections that aren't real app errors
    if (
      event.exception?.values?.[0]?.type === "UnhandledRejection" &&
      typeof error === "string"
    ) return null;

    return event;
  },
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
