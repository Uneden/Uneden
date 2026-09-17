/**
 * API base URL for fetches that run on the Next.js server (Server Components,
 * sitemap). In Docker the server cannot reach the browser-facing
 * NEXT_PUBLIC_API_URL (localhost is the container itself), so compose sets
 * API_URL_INTERNAL to the backend service's address. Outside Docker the two
 * are the same and this is a plain fallback.
 */
export const SERVER_API_URL =
  process.env.API_URL_INTERNAL || process.env.NEXT_PUBLIC_API_URL;
