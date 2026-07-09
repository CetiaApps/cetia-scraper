import { absoluteTescoUrl } from "../utils/normalise.js";
import { fetchViaBrightData } from "../services/brightdata.js";

export interface TescoIndexedPage {
  page_url: string;
  product_id: string | null;
  sitemap_url: string | null;
}

export interface TescoSitemapError {
  url: string;
  http_status: number | null;
  error_code: string;
  error_message: string;
}

export interface TescoSitemapIndexResult {
  pages: TescoIndexedPage[];
  errors: TescoSitemapError[];
  sitemap_urls_processed: number;
  pages_found: number;
  pages_skipped: number;
}

const DEFAULT_SITEMAPS = [
  "https://www.tesco.com/sitemap.xml",
  "https://www.tesco.com/sitemaps/en-GB/groceries/products-index.xml",
];

function extractLocs(xml: string): string[] {
  const locs: string[] = [];
  const re = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
  let match: RegExpExecArray | null;

  while ((match = re.exec(xml))) {
    locs.push(match[1].replace(/&amp;/g, "&").trim());
  }

  return locs;
}

function isSitemapUrl(url: string): boolean {
  return /sitemap/i.test(url) && /\.xml(?:\.gz)?(?:$|\?)/i.test(url);
}

export function productIdFromTescoUrl(url: string): string | null {
  const match = url.match(/\/(?:groceries|shop)\/en-GB\/products\/([^/?#]+)/i);
  return match?.[1] ?? null;
}

export function isTescoProductUrl(url: string): boolean {
  return /^https:\/\/www\.tesco\.com\/(?:groceries|shop)\/en-GB\/products\/[^/?#]+/i.test(
    url,
  );
}

function cleanSitemaps(value: unknown): string[] {
  if (!Array.isArray(value)) return DEFAULT_SITEMAPS;
  const urls = value.filter(
    (url): url is string => typeof url === "string" && url.trim().length > 0,
  );
  return urls.length > 0 ? urls : DEFAULT_SITEMAPS;
}

export async function indexTescoSitemap(input: {
  sitemap_urls?: unknown;
  max_pages?: unknown;
  max_depth?: unknown;
  offset?: unknown;
}): Promise<TescoSitemapIndexResult> {
  const maxPages = Math.min(Math.max(Number(input.max_pages) || 100, 1), 60000);
  const maxDepth = Math.min(Math.max(Number(input.max_depth) || 2, 0), 5);
  const offset = Math.min(Math.max(Number(input.offset) || 0, 0), 100000);
  const queue = cleanSitemaps(input.sitemap_urls).map((url) => ({
    url,
    depth: 0,
    parent: null as string | null,
  }));
  const visited = new Set<string>();
  const pages = new Map<string, TescoIndexedPage>();
  const errors: TescoSitemapError[] = [];
  let processed = 0;
  let productUrlsSeen = 0;

  while (queue.length > 0 && pages.size < maxPages && visited.size < 500) {
    const current = queue.shift()!;
    if (visited.has(current.url) || current.depth > maxDepth) continue;
    visited.add(current.url);

    try {
      const response = await fetchViaBrightData(current.url);

      if (!response.ok) {
        errors.push({
          url: current.url,
          http_status: response.status,
          error_code: "BRIGHTDATA_SITEMAP_FETCH_ERROR",
          error_message: `Bright Data sitemap fetch failed with HTTP ${response.status}: ${response.body.slice(0, 500)}`,
        });
        continue;
      }

      processed += 1;

      for (const loc of extractLocs(response.body)) {
        if (pages.size >= maxPages) break;
        const absoluteUrl = absoluteTescoUrl(loc);
        if (!absoluteUrl) continue;

        if (isTescoProductUrl(absoluteUrl)) {
          productUrlsSeen += 1;
          if (productUrlsSeen <= offset) continue;
          pages.set(absoluteUrl, {
            page_url: absoluteUrl,
            product_id: productIdFromTescoUrl(absoluteUrl),
            sitemap_url: current.url,
          });
          continue;
        }

        if (
          isSitemapUrl(absoluteUrl) &&
          !visited.has(absoluteUrl) &&
          current.depth + 1 <= maxDepth
        ) {
          queue.push({
            url: absoluteUrl,
            depth: current.depth + 1,
            parent: current.url,
          });
        }
      }
    } catch (error) {
      errors.push({
        url: current.url,
        http_status: null,
        error_code: "BRIGHTDATA_SITEMAP_FETCH_EXCEPTION",
        error_message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    pages: Array.from(pages.values()),
    errors,
    sitemap_urls_processed: processed,
    pages_found: pages.size,
    pages_skipped: Math.min(productUrlsSeen, offset),
  };
}
