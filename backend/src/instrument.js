// Loaded before the app via `node --import ./src/instrument.js` so Sentry can
// patch Express/pg/http before they are imported (required in ESM). server.js
// also imports this file as a fallback; ESM evaluates a module once, so init
// never runs twice.
import "dotenv/config";
import * as Sentry from "@sentry/node";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0.1,
  environment: process.env.NODE_ENV || "production",
});
