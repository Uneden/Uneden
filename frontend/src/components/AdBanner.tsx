"use client";
// AdSense banner — disabled until Google AdSense approval.
// To re-enable: remove the "return null" line below and uncomment the AdSense Script in layout.tsx,
// and render ads only when the visitor consented (useConsent(): choices.advertising).

interface AdBannerProps {
  slot: string;
  format?: "auto" | "horizontal" | "vertical" | "rectangle";
  className?: string;
  style?: React.CSSProperties;
}

export default function AdBanner(_props: AdBannerProps) {
  return null;

  /* --- restore below when approved ---
  import { useEffect } from "react";
  useEffect(() => {
    try {
      ((window as any).adsbygoogle = (window as any).adsbygoogle || []).push({});
    } catch { }
  }, []);
  return (
    <ins
      className={`adsbygoogle ${_props.className ?? ""}`}
      style={{ display: "block", ..._props.style }}
      data-ad-client="ca-pub-1987537963844035"
      data-ad-slot={_props.slot}
      data-ad-format={_props.format ?? "auto"}
      data-full-width-responsive="true"
    />
  );
  */
}
