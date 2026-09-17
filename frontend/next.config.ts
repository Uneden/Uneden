import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

// A local Supabase (`npx supabase start`) lives on http://127.0.0.1:54321, which
// the production CSP would block. Derive the extra origins from the configured
// URL so nothing changes when it points at *.supabase.co.
const LOCAL_SUPABASE_ORIGINS = (() => {
  try {
    const origin = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").origin;
    if (origin.endsWith(".supabase.co")) return "";
    return ` ${origin} ${origin.replace(/^http/, "ws")}`;
  } catch {
    return "";
  }
})();

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://js.stripe.com https://connect-js.stripe.com https://maps.googleapis.com https://va.vercel-scripts.com https://pagead2.googlesyndication.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com",
  `img-src 'self' data: https: blob: https://*.supabase.co https://images.unsplash.com https://maps.googleapis.com https://maps.gstatic.com${LOCAL_SUPABASE_ORIGINS}`,
  "font-src 'self' data: https://fonts.gstatic.com",
  `connect-src 'self' https://*.supabase.co wss://*.supabase.co https://uneden.onrender.com http://localhost:5000 https://va.vercel-scripts.com https://maps.googleapis.com https://pagead2.googlesyndication.com https://googleads.g.doubleclick.net https://api.stripe.com https://connect-js.stripe.com${LOCAL_SUPABASE_ORIGINS}`,
  `media-src 'self' blob: https://*.supabase.co${LOCAL_SUPABASE_ORIGINS}`,
  "frame-src https://js.stripe.com https://connect-js.stripe.com https://www.google.com/maps/embed/",
  "object-src 'none'",
  "worker-src 'self' blob:",
].join("; ");

const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-XSS-Protection", value: "1; mode=block" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=(self)" },
  { key: "Content-Security-Policy", value: CSP },
];

const nextConfig: NextConfig = {
  reactCompiler: true,
  // "standalone" emits a self-contained server (.next/standalone) for the Docker
  // image. Only enabled from the Dockerfile so the Vercel build is untouched.
  output: process.env.NEXT_OUTPUT_STANDALONE === "1" ? "standalone" : undefined,
  async headers() {
    return [{ source: "/(.*)", headers: SECURITY_HEADERS }];
  },
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: "uneden.com" }],
        destination: "https://www.uneden.ca/:path*",
        permanent: true,
      },
      {
        source: "/:path*",
        has: [{ type: "host", value: "www.uneden.com" }],
        destination: "https://www.uneden.ca/:path*",
        permanent: true,
      },
      // Legacy Stripe Checkout / PaymentIntent return pages → bookings (confirmation is in-modal)
      {
        source: "/payment/success",
        destination: "/bookings?payment=success",
        permanent: false,
      },
      {
        source: "/payment/:bookingId",
        destination: "/bookings?booking=:bookingId",
        permanent: false,
      },
    ];
  },
  images: {
    formats: ['image/webp'],
    deviceSizes: [390, 640, 828, 1080, 1200],
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*.supabase.co',
        pathname: '/storage/v1/object/**',
      },
      {
        // Supabase Image Transform API (resized/compressed on-the-fly)
        protocol: 'https',
        hostname: '*.supabase.co',
        pathname: '/storage/v1/render/image/**',
      },
      {
        protocol: 'https',
        hostname: 'images.unsplash.com',
      },
      {
        protocol: 'https',
        hostname: 'cdn.jsdelivr.net',
      },
    ],
  },
};

export default withSentryConfig(nextConfig, {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options

  org: "uneden",

  project: "javascript-nextjs",

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  webpack: {
    // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
    // See the following for more information:
    // https://docs.sentry.io/product/crons/
    // https://vercel.com/docs/cron-jobs
    automaticVercelMonitors: true,

    // Tree-shaking options for reducing bundle size
    treeshake: {
      // Automatically tree-shake Sentry logger statements to reduce bundle size
      removeDebugLogging: true,
    },
  },
});
