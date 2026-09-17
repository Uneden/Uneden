import { SERVER_API_URL } from "@/lib/serverApiUrl";
import { Metadata } from "next";
import ServiceDetailClient from "./ServiceDetailClient";
import { getSafeMetadataImageUrl } from "@/lib/image";
import { listingMetaPriceSegment } from "@/lib/listingPrice";

const API_URL = SERVER_API_URL;

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  try {
    const { id } = await params;
    const res = await fetch(`${API_URL}/services/${id}`, { next: { revalidate: 3600 } });
    if (!res.ok) return {};
    const service = await res.json();

    const priceSeg = listingMetaPriceSegment(service, "fr");
    const title = `${service.title} — ${priceSeg} | Uneden`;
    const description = service.description
      ? service.description.slice(0, 155)
      : `Découvre ce service sur Uneden — ${service.city ?? service.location ?? "Québec"}.`;
    const image = getSafeMetadataImageUrl(service.image_url) ?? "https://uneden.ca/og-image.png";

    return {
      title,
      description,
      openGraph: {
        title,
        description,
        url: `https://uneden.ca/serviceDetail/${id}`,
        images: [{ url: image, width: 1200, height: 630 }],
      },
      twitter: {
        card: "summary_large_image",
        title,
        description,
        images: [image],
      },
    };
  } catch {
    return {};
  }
}

async function fetchService(id: string) {
  try {
    const res = await fetch(`${API_URL}/services/${id}`, { next: { revalidate: 60 } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export default async function ServiceDetailPage({ params }: Props) {
  const { id } = await params;
  const initialService = await fetchService(id);
  return <ServiceDetailClient initialService={initialService} />;
}
