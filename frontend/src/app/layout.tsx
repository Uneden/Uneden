import type { Metadata, Viewport } from "next";
import "@/lib/i18n";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/contexts/AuthContext";
import { AuthGateProvider } from "@/contexts/AuthGateContext";
import ConditionalShell from "@/components/ConditionalShell";
import LogoutOverlay from "@/components/LogoutOverlay";
import { AuthBootstrapOverlay } from "@/components/auth/AuthBootstrapOverlay";
import ComingSoonOverlay from "@/components/ComingSoonOverlay";
import AppToaster from "@/components/AppToaster";
import CookieConsent from "@/components/consent/CookieConsent";
import ConsentGatedServices from "@/components/consent/ConsentGatedServices";
import Script from "next/script";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Uneden · Trouve de l'aide près de chez toi",
    template: "%s | Uneden",
  },
  description: "Uneden connecte les gens de ta communauté pour offrir et trouver des services locaux. Publie ton service ou trouve de l'aide près de chez toi.",
  keywords: ["services locaux", "communauté", "aide", "prestataire", "Québec", "Canada", "Uneden"],
  metadataBase: new URL("https://uneden.ca"),
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-16x16.png", type: "image/png", sizes: "16x16" },
      { url: "/favicon-32x32.png", type: "image/png", sizes: "32x32" },
      { url: "/android-chrome-192x192.png", type: "image/png", sizes: "192x192" },
      { url: "/android-chrome-512x512.png", type: "image/png", sizes: "512x512" },
    ],
    shortcut: [{ url: "/favicon.ico" }],
    apple: [{ url: "/apple-touch-icon.png" }],
  },
  alternates: {
    canonical: "https://uneden.ca",
    languages: {
      "fr-CA": "https://uneden.ca",
      "en-CA": "https://uneden.ca/en",
    },
  },
  openGraph: {
    type: "website",
    url: "https://uneden.ca",
    siteName: "Uneden",
    title: "Uneden · Trouve de l'aide près de chez toi",
    description: "Connecte-toi avec ta communauté pour offrir et trouver des services locaux.",
    images: [
      {
        url: "https://uneden.ca/og-image.png",
        width: 1200,
        height: 630,
        alt: "Uneden · Trouve de l'aide près de chez toi",
      },
    ],
    locale: "fr_CA",
  },
  twitter: {
    card: "summary",
    title: "Uneden · Trouve de l'aide près de chez toi",
    description: "Connecte-toi avec ta communauté pour offrir et trouver des services locaux.",
    images: ["https://uneden.ca/og-image.png"],
  },
  robots: {
    index: true,
    follow: true,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* AdSense — disabled until approved. To re-enable: render this Script
            only when hasConsent("advertising") (see lib/consent.ts), and show
            the advertising category there.
        <Script
          async
          src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1987537963844035"
          crossOrigin="anonymous"
          strategy="afterInteractive"
        />
        */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "Organization",
              name: "Uneden",
              url: "https://uneden.ca",
              logo: "https://uneden.ca/logo.png",
              description: "Uneden connecte les gens de ta communauté pour offrir et trouver des services locaux.",
              address: { "@type": "PostalAddress", addressCountry: "CA", addressRegion: "QC" },
              sameAs: [
                "https://github.com/Uneden",
                "https://www.linkedin.com/company/uneden",
              ],
            }),
          }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "WebSite",
              name: "Uneden",
              alternateName: "Uneden.ca",
              url: "https://uneden.ca",
              description: "Uneden connecte les gens de ta communauté pour offrir et trouver des services locaux.",
              inLanguage: ["fr-CA", "en-CA"],
              potentialAction: {
                "@type": "SearchAction",
                target: {
                  "@type": "EntryPoint",
                  urlTemplate: "https://uneden.ca/search?q={search_term_string}",
                },
                "query-input": "required name=search_term_string",
              },
            }),
          }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased min-h-screen flex flex-col bg-white text-black`}
        suppressHydrationWarning
      >
        <AuthProvider>
          <AuthGateProvider>
          <ComingSoonOverlay />
          <ConditionalShell>{children}</ConditionalShell>
          <LogoutOverlay />
          <AuthBootstrapOverlay />
          <AppToaster />
          {/* Analytics, Speed Insights and Session Replay only after consent */}
          <ConsentGatedServices />
          <CookieConsent />
          </AuthGateProvider>
        </AuthProvider>
      </body>
    </html>
  );
}