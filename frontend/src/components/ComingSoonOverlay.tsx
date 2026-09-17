"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { Loader2, Send, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const COMING_SOON = process.env.NEXT_PUBLIC_COMING_SOON === "true";

const CONTENT = {
  en: {
    slogan: "Skills live in every neighborhood.\nUneden connects them.",
    logo: "Uneden",
    heading: "We're almost ready.",
    subheading: "Something exciting is coming. Be the first to know when Uneden will launch in your community.",
    placeholder: "Your email address",
    cta: "Notify me",
    success: "You're on the list! We'll let you know as soon as we launch.",
    privacy: "We respect your privacy. No spam, ever.",
    alreadyAccount: null,
  },
  fr: {
    slogan: "Les talents vivent partout.\nUneden les connecte.",
    logo: "Uneden",
    heading: "On arrive bientôt.",
    subheading: "Quelque chose d'excitant se prépare. Soyez le premier à savoir quand Uneden sera lancé dans votre communauté.",
    placeholder: "Votre adresse courriel",
    cta: "Me notifier",
    success: "Vous êtes sur la liste ! On vous avertit dès le lancement.",
    privacy: "Nous respectons votre vie privée. Aucun spam.",
    alreadyAccount: null,
  },
};

export default function ComingSoonOverlay() {
  const pathname = usePathname();
  const lang: "en" | "fr" = pathname?.startsWith("/fr") ? "fr" : "en";
  const c = CONTENT[lang];
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!COMING_SOON) return;

    const prevent = (e: Event) => e.preventDefault();
    document.body.style.overflow = "hidden";
    document.body.style.touchAction = "none";
    document.addEventListener("wheel", prevent, { passive: false });
    document.addEventListener("touchmove", prevent, { passive: false });

    return () => {
      document.body.style.overflow = "";
      document.body.style.touchAction = "";
      document.removeEventListener("wheel", prevent);
      document.removeEventListener("touchmove", prevent);
    };
  }, []);

  if (!COMING_SOON) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || done) return;
    setError("");
    setLoading(true);
    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/auth/waitlist`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, lang }),
        }
      );
      if (res.ok) {
        setDone(true);
      } else {
        const d = await res.json().catch(() => ({}));
        setError(d.message ?? (lang === "fr" ? "Une erreur est survenue." : "Something went wrong."));
      }
    } catch {
      setError(lang === "fr" ? "Vérifiez votre connexion." : "Check your connection.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-3 sm:p-6"
      style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full overflow-hidden flex flex-col md:flex-row"
           style={{ maxWidth: 860, maxHeight: "calc(100vh - 24px)" }}>

        {/* ── TOP banner on mobile / LEFT panel on desktop ── */}
        <div
          className="flex md:hidden flex-col justify-end relative overflow-hidden"
          style={{
            backgroundImage: `url('https://images.unsplash.com/photo-1521791136064-7986c2920216?w=800&q=80')`,
            backgroundSize: "cover",
            backgroundPosition: "center top",
            minHeight: 140,
          }}
        >
          <div className="absolute inset-0"
               style={{ background: "linear-gradient(to top, rgba(1,31,13,0.92) 0%, rgba(2,60,25,0.60) 55%, rgba(0,0,0,0.15) 100%)" }} />
          <div className="relative z-10 px-5 py-4">
            <p className="text-green-400 text-[10px] font-semibold uppercase tracking-widest mb-1">
              {lang === "fr" ? "Bientôt disponible" : "Coming soon"}
            </p>
            <p className="text-white text-base font-bold leading-snug whitespace-pre-line">
              {c.slogan}
            </p>
          </div>
        </div>

        {/* ── LEFT panel on desktop ── */}
        <div
          className="hidden md:flex flex-col justify-end w-[44%] relative overflow-hidden shrink-0"
          style={{
            backgroundImage: `url('https://images.unsplash.com/photo-1521791136064-7986c2920216?w=800&q=80')`,
            backgroundSize: "cover",
            backgroundPosition: "center",
          }}
        >
          <div className="absolute inset-0"
               style={{ background: "linear-gradient(to top, rgba(1,31,13,0.92) 0%, rgba(2,60,25,0.60) 55%, rgba(0,0,0,0.15) 100%)" }} />
          <div className="absolute top-6 right-6 w-24 h-24 rounded-full border border-white/10" />
          <div className="absolute top-10 right-10 w-12 h-12 rounded-full border border-white/10" />
          <div className="relative z-10 p-8 pb-10">
            <p className="text-green-400 text-xs font-semibold uppercase tracking-widest mb-4">
              {lang === "fr" ? "Bientôt disponible" : "Coming soon"}
            </p>
            <p className="text-white text-2xl font-bold leading-snug whitespace-pre-line">
              {c.slogan}
            </p>
            <div className="mt-6 flex items-center gap-2">
              <div className="w-8 h-0.5 bg-green-400" />
              <span className="text-green-300 text-xs font-medium">Uneden</span>
            </div>
          </div>
        </div>

        {/* ── RIGHT: content ── */}
        <div className="flex-1 flex flex-col justify-center px-5 py-7 sm:px-8 sm:py-12 overflow-y-auto">
          <div className="max-w-sm mx-auto w-full">

            {/* Logo */}
            <p className="text-3xl sm:text-4xl font-black text-green-700 mb-1 tracking-tight"
               style={{ fontFamily: "var(--font-geist-sans)" }}>
              {c.logo}
            </p>

            {/* Heading */}
            <h1 className="text-xl sm:text-2xl font-bold text-gray-900 mt-4 sm:mt-5 mb-2 leading-tight">
              {c.heading}
            </h1>
            <p className="text-sm text-gray-500 leading-relaxed mb-6 sm:mb-8">
              {c.subheading}
            </p>

            {done ? (
              <div className="flex items-start gap-3 bg-green-50 border border-green-200 rounded-xl px-4 py-4">
                <CheckCircle2 className="h-5 w-5 text-green-600 mt-0.5 shrink-0" />
                <p className="text-sm text-green-800 font-medium">{c.success}</p>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-3">
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={c.placeholder}
                  required
                  className="h-12 text-sm rounded-xl border-gray-300 focus:ring-green-500 focus:border-green-500"
                />
                {error && (
                  <p className="text-xs text-red-600">{error}</p>
                )}
                <Button
                  type="submit"
                  disabled={loading}
                  className="w-full h-12 bg-green-700 hover:bg-green-800 text-white rounded-xl font-semibold text-sm gap-2"
                >
                  {loading
                    ? <><Loader2 className="h-4 w-4 animate-spin" /> {lang === "fr" ? "Envoi..." : "Sending..."}</>
                    : <><Send className="h-4 w-4" /> {c.cta}</>
                  }
                </Button>
              </form>
            )}

            <p className="text-xs text-gray-400 mt-4 sm:mt-5 text-center">{c.privacy}</p>

            {/* Language switcher */}
            <div className="flex items-center justify-center gap-3 mt-5 sm:mt-6 text-xs text-gray-400">
              <Link href="/" className={`hover:text-green-700 transition-colors ${lang === "en" ? "font-semibold text-green-700" : ""}`}>English</Link>
              <span>·</span>
              <Link href="/fr" className={`hover:text-green-700 transition-colors ${lang === "fr" ? "font-semibold text-green-700" : ""}`}>Français</Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
