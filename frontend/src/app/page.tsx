import { SERVER_API_URL } from "@/lib/serverApiUrl";
import HomePageClient, {
  type HomeCategoryCount,
  type HomeListing,
} from "@/components/home/HomePageClient";

const API_URL = SERVER_API_URL;

async function fetchInitialListings(): Promise<HomeListing[]> {
  try {
    const res = await fetch(`${API_URL}/services?limit=12`, { cache: "no-store" });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? (data as HomeListing[]) : [];
  } catch {
    return [];
  }
}

async function fetchCategoryCounts(): Promise<HomeCategoryCount[]> {
  try {
    const res = await fetch(`${API_URL}/services/category-counts`, { cache: "force-cache" });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? (data as HomeCategoryCount[]) : [];
  } catch {
    return [];
  }
}

export default async function HomePage() {
  const [initialListings, initialCategoryCounts] = await Promise.all([
    fetchInitialListings(),
    fetchCategoryCounts(),
  ]);

  return (
    <HomePageClient
      initialListings={initialListings}
      initialCategoryCounts={initialCategoryCounts}
    />
  );
}
