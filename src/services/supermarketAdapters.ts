import { createSupabaseServiceClient } from "./supabase.js";

type SupabaseClient = ReturnType<typeof createSupabaseServiceClient>;

export const ACTIVE_SUPERMARKETS = [
  { code: "tesco", name: "Tesco" },
  { code: "aldi", name: "Aldi" },
  { code: "asda", name: "ASDA" },
  { code: "morrisons", name: "Morrisons" },
  { code: "ocado", name: "Ocado/M&S" },
  { code: "sainsburys", name: "Sainsbury's" },
  { code: "waitrose", name: "Waitrose" },
] as const;

export type SupermarketCode = (typeof ACTIVE_SUPERMARKETS)[number]["code"];

export interface SupermarketIndexInput {
  run_id?: unknown;
  max_pages?: unknown;
  sitemap_urls?: unknown;
}

export interface SupermarketIndexResult {
  success: boolean;
  supermarket_code: SupermarketCode;
  supermarket_name: string;
  run_id: string | null;
  pages_found: number;
  pages_inserted_or_updated: number;
  sitemap_urls_processed: number;
  errors: Array<{
    url: string | null;
    http_status: number | null;
    error_code: string;
    error_message: string;
  }>;
  message: string;
}

interface Adapter {
  code: SupermarketCode;
  name: string;
  supportsIndexing: boolean;
  supportsPriceScraping: boolean;
  defaultSitemapUrls: string[];
  productUrlPattern: RegExp;
  extractProductId(url: string): string | null;
}

export const supermarketAdapters: Record<SupermarketCode, Adapter> = {
  tesco: {
    code: "tesco",
    name: "Tesco",
    supportsIndexing: true,
    supportsPriceScraping: true,
    defaultSitemapUrls: ["https://www.tesco.com/sitemap.xml"],
    productUrlPattern: /tesco\.com\/(?:groceries\/en-GB|shop\/en-GB)\/products\/\d+/i,
    extractProductId(url) {
      return /\/products\/(\d+)/i.exec(url)?.[1] ?? null;
    },
  },
  aldi: {
    code: "aldi",
    name: "Aldi",
    supportsIndexing: true,
    supportsPriceScraping: false,
    defaultSitemapUrls: ["https://www.aldi.co.uk/sitemap.xml"],
    productUrlPattern: /aldi\.co\.uk\/.+\/p\/[a-z0-9-]+/i,
    extractProductId(url) {
      return /\/p\/([a-z0-9-]+)/i.exec(url)?.[1] ?? null;
    },
  },
  asda: unsupported("asda", "ASDA"),
  morrisons: unsupported("morrisons", "Morrisons"),
  ocado: unsupported("ocado", "Ocado/M&S"),
  sainsburys: unsupported("sainsburys", "Sainsbury's"),
  waitrose: unsupported("waitrose", "Waitrose"),
};

function unsupported(code: SupermarketCode, name: string): Adapter {
  return {
    code,
    name,
    supportsIndexing: false,
    supportsPriceScraping: false,
    defaultSitemapUrls: [],
    productUrlPattern: /$a/,
    extractProductId: () => null,
  };
}

function clampInt(value: unknown, fallback: number, min: number, max: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

function envSitemapUrls(code: SupermarketCode): string[] | null {
  const key = `${code.toUpperCase()}_SITEMAP_URLS`;
  const raw = process.env[key];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((url) => typeof url === "string" && url.trim());
  } catch {
    return raw
      .split(",")
      .map((url) => url.trim())
      .filter(Boolean);
  }
  return null;
}

function locsFromXml(xml: string): string[] {
  const locs: string[] = [];
  const regex = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml))) {
    locs.push(match[1].replace(/&amp;/g, "&").trim());
  }
  return locs;
}

function isLikelySitemap(url: string) {
  return /sitemap|\.xml(?:$|\?)/i.test(url);
}

async function createRun(
  supabase: SupabaseClient,
  adapter: Adapter,
  inputRunId: unknown,
  maxPages: number,
) {
  if (typeof inputRunId === "string" && inputRunId.trim()) return inputRunId.trim();

  const { data, error } = await supabase
    .from("supermarket_price_scrape_runs")
    .insert({
      supermarket_code: adapter.code,
      supermarket_name: adapter.name,
      status: "indexing",
      phase: "page_indexing",
      trigger_source: "railway_supermarket_indexer",
      max_pages: maxPages,
      last_message: `${adapter.name} page indexing started`,
      config: {
        supermarket_code: adapter.code,
        source: "railway_supermarket_indexer",
        max_pages: maxPages,
      },
      started_at: new Date().toISOString(),
      last_heartbeat_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error || !data) throw new Error(error?.message || "Failed to create index run");
  return String(data.id);
}

async function updateRun(
  supabase: SupabaseClient,
  runId: string,
  patch: Record<string, unknown>,
) {
  const { error } = await supabase
    .from("supermarket_price_scrape_runs")
    .update({
      ...patch,
      last_heartbeat_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", runId);
  if (error) throw new Error(error.message);
}

async function logIndexError(
  supabase: SupabaseClient,
  adapter: Adapter,
  runId: string,
  error: SupermarketIndexResult["errors"][number],
) {
  await supabase.from("supermarket_price_scrape_errors").insert({
    run_id: runId,
    supermarket_code: adapter.code,
    phase: "page_indexing",
    severity: "error",
    url: error.url,
    http_status: error.http_status,
    error_code: error.error_code,
    error_message: error.error_message,
    metadata: { supermarket_code: adapter.code },
  });
}

export function getSupermarketAdapter(code: unknown): Adapter | null {
  if (typeof code !== "string") return null;
  return supermarketAdapters[code.toLowerCase() as SupermarketCode] ?? null;
}

export async function indexSupermarketPages(
  code: SupermarketCode,
  input: SupermarketIndexInput,
): Promise<SupermarketIndexResult> {
  const adapter = supermarketAdapters[code];
  if (!adapter.supportsIndexing) {
    return {
      success: false,
      supermarket_code: adapter.code,
      supermarket_name: adapter.name,
      run_id: null,
      pages_found: 0,
      pages_inserted_or_updated: 0,
      sitemap_urls_processed: 0,
      errors: [
        {
          url: null,
          http_status: null,
          error_code: "SUPERMARKET_INDEXING_UNSUPPORTED",
          error_message: `${adapter.name} indexing is not implemented yet`,
        },
      ],
      message: `${adapter.name} indexing is not implemented yet`,
    };
  }

  const supabase = createSupabaseServiceClient();
  const maxPages = clampInt(input.max_pages, code === "aldi" ? 1000 : 1000, 1, 10_000);
  const runId = await createRun(supabase, adapter, input.run_id, maxPages);
  await updateRun(supabase, runId, {
    status: "indexing",
    phase: "page_indexing",
    started_at: new Date().toISOString(),
    last_message: `${adapter.name} page indexing running`,
  });

  const requestedUrls = Array.isArray(input.sitemap_urls)
    ? input.sitemap_urls.filter((url): url is string => typeof url === "string" && url.trim().length > 0)
    : null;
  const queue = [...(requestedUrls ?? envSitemapUrls(code) ?? adapter.defaultSitemapUrls)];
  const seenSitemaps = new Set<string>();
  const seenPages = new Set<string>();
  const pages: Array<{ page_url: string; product_id: string | null; sitemap_url: string | null }> = [];
  const errors: SupermarketIndexResult["errors"] = [];
  let sitemapUrlsProcessed = 0;

  while (queue.length > 0 && pages.length < maxPages && seenSitemaps.size < 5000) {
    const sitemapUrl = queue.shift()!;
    if (seenSitemaps.has(sitemapUrl)) continue;
    seenSitemaps.add(sitemapUrl);
    sitemapUrlsProcessed += 1;

    try {
      const response = await fetch(sitemapUrl, {
        headers: {
          accept: "application/xml,text/xml,text/plain,*/*",
          "user-agent": "CetiaDataServices/1.0 supermarket page indexer",
        },
        signal: AbortSignal.timeout(45_000),
      });
      const text = await response.text();
      if (!response.ok) {
        const item = {
          url: sitemapUrl,
          http_status: response.status,
          error_code: "SUPERMARKET_SITEMAP_FETCH_FAILED",
          error_message: `${adapter.name} sitemap fetch failed with HTTP ${response.status}`,
        };
        errors.push(item);
        await logIndexError(supabase, adapter, runId, item);
        continue;
      }

      for (const loc of locsFromXml(text)) {
        if (adapter.productUrlPattern.test(loc)) {
          const cleanUrl = loc.split("#")[0];
          if (!seenPages.has(cleanUrl)) {
            seenPages.add(cleanUrl);
            pages.push({
              page_url: cleanUrl,
              product_id: adapter.extractProductId(cleanUrl),
              sitemap_url: sitemapUrl,
            });
            if (pages.length >= maxPages) break;
          }
        } else if (isLikelySitemap(loc) && !seenSitemaps.has(loc)) {
          queue.push(loc);
        }
      }

      if (sitemapUrlsProcessed % 10 === 0) {
        await updateRun(supabase, runId, {
          pages_indexed: pages.length,
          last_message: `${adapter.name} indexing scanned ${sitemapUrlsProcessed} sitemap(s), found ${pages.length} product page(s)`,
        });
      }
    } catch (error) {
      const item = {
        url: sitemapUrl,
        http_status: null,
        error_code: "SUPERMARKET_SITEMAP_INDEX_EXCEPTION",
        error_message: error instanceof Error ? error.message : String(error),
      };
      errors.push(item);
      await logIndexError(supabase, adapter, runId, item);
    }
  }

  let written = 0;
  for (let index = 0; index < pages.length; index += 500) {
    const batch = pages.slice(index, index + 500).map((page) => ({
      run_id: runId,
      supermarket_code: adapter.code,
      supermarket_name: adapter.name,
      sitemap_url: page.sitemap_url,
      page_url: page.page_url,
      product_id: page.product_id,
      page_type: "product",
      index_status: "indexed",
      scrape_status: "pending",
      raw_index_data: {
        source: "railway_supermarket_indexer",
        supermarket_code: adapter.code,
        indexed_at: new Date().toISOString(),
      },
      updated_at: new Date().toISOString(),
    }));
    const { error } = await supabase
      .from("supermarket_page_index")
      .upsert(batch, { onConflict: "supermarket_code,page_url" });
    if (error) throw new Error(error.message);
    written += batch.length;
  }

  const status = pages.length > 0 ? "indexed" : "failed";
  const message =
    pages.length > 0
      ? `${adapter.name} indexed ${written} product page URL(s)`
      : `${adapter.name} indexing found no product page URLs`;

  await updateRun(supabase, runId, {
    status,
    phase: status === "indexed" ? "page_indexed" : "page_index_failed",
    pages_indexed: written,
    pages_pending: written,
    errors_count: errors.length,
    last_message: message,
    last_error: errors[0]?.error_message ?? (pages.length > 0 ? null : message),
    finished_at: new Date().toISOString(),
  });

  return {
    success: pages.length > 0,
    supermarket_code: adapter.code,
    supermarket_name: adapter.name,
    run_id: runId,
    pages_found: pages.length,
    pages_inserted_or_updated: written,
    sitemap_urls_processed: sitemapUrlsProcessed,
    errors,
    message,
  };
}
