import { SERVER_API_URL } from "@/lib/serverApiUrl";
import { MetadataRoute } from "next";

const API_URL = SERVER_API_URL;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticRoutes: MetadataRoute.Sitemap = [
    {
      url: "https://uneden.ca",
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 1,
    },
    {
      url: "https://uneden.ca/listings",
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 0.9,
    },
    {
      url: "https://uneden.ca/login",
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.5,
    },
    {
      url: "https://uneden.ca/register",
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.5,
    },
  ];

  try {
    const res = await fetch(`${API_URL}/services`, { next: { revalidate: 3600 } });
    if (!res.ok) return staticRoutes;
    const services: Array<{ id: string; created_at: string }> = await res.json();

    const serviceRoutes: MetadataRoute.Sitemap = services.map((s) => ({
      url: `https://uneden.ca/serviceDetail/${s.id}`,
      lastModified: new Date(s.created_at),
      changeFrequency: "weekly",
      priority: 0.7,
    }));

    return [...staticRoutes, ...serviceRoutes];
  } catch {
    return staticRoutes;
  }
}
