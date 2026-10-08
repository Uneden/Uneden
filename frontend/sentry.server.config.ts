// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: "https://7cd85ab49bc4314b86bbc83a5215c87d@o4511106103640064.ingest.us.sentry.io/4511106105540608",

  // No telemetry in dev — avoids noisy network errors in the terminal.
  enabled: process.env.NODE_ENV === "production",

  // Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
  tracesSampleRate: 0.1,

  // Enable logs to be sent to Sentry
  enableLogs: true,

  // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#sendDefaultPii
  // Off: error reports must not carry visitors' IP address, cookies or headers.
  sendDefaultPii: false,

  // Disable OpenTelemetry auto-instrumentation to avoid import-in-the-middle resolution warnings with Turbopack
  skipOpenTelemetrySetup: true,
});
