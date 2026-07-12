import { createSupabaseServiceClient } from "./supabase.js";
import { fetchViaBrightData } from "./brightdata.js";
import {
  SCRAPE_SCOPE_CLASSIFIER_VERSION,
  buildScrapeScopeInputHash,
  classifyScrapeScope,
  type ScrapeScopeResult,
} from "./scrapeScopeClassifier.js";

type SupabaseClient = ReturnType<typeof createSupabaseServiceClient>;
type SupabaseErrorLike = {
  message?: string;
  code?: string;
  details?: string;
  hint?: string;
};

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
  run_mode?: unknown;
  allow_partial_completion?: unknown;
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
  source_control_total: number;
  unique_urls_discovered: number;
  database_total_before: number;
  database_total_after: number;
  existing_urls_count: number;
  new_urls_inserted: number;
  urls_updated: number;
  duplicate_urls_count: number;
  invalid_urls_count: number;
  missing_url_count: number;
  unexpected_extra_count: number;
  reconciliation_status: string;
  message: string;
}

interface Adapter {
  code: SupermarketCode;
  name: string;
  supportsIndexing: boolean;
  supportsPriceScraping: boolean;
  defaultSitemapUrls: string[];
  productUrlPattern: RegExp;
  pageType?: "product" | "category";
  extractProductId(url: string): string | null;
}

type IndexedPageType = "product" | "category";

interface IndexedPageCandidate {
  page_url: string;
  normalized_page_url: string;
  product_id: string | null;
  sitemap_url: string | null;
  page_type: IndexedPageType;
  raw_index_data?: Record<string, unknown>;
}

const SAINSBURYS_ERROR_SAMPLE_LIMIT = 50;

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
    defaultSitemapUrls: ["https://www.aldi.co.uk/sitemap_products.xml"],
    productUrlPattern: /aldi\.co\.uk\/product\/[^/?#]+-\d+(?:$|[/?#])/i,
    extractProductId(url) {
      return /-(\d+)(?:$|[/?#])/i.exec(url)?.[1] ?? null;
    },
  },
  asda: {
    code: "asda",
    name: "ASDA",
    supportsIndexing: true,
    supportsPriceScraping: false,
    defaultSitemapUrls: ["https://www.asda.com/sitemap-index.xml"],
    productUrlPattern: /asda\.com\/groceries\/product\/[^?#]+/i,
    extractProductId(url) {
      const path = new URL(url).pathname.split("/").filter(Boolean);
      return path.at(-1) ?? null;
    },
  },
  morrisons: {
    code: "morrisons",
    name: "Morrisons",
    supportsIndexing: true,
    supportsPriceScraping: false,
    defaultSitemapUrls: ["https://groceries.morrisons.com/sitemaps/sitemap_index.xml"],
    productUrlPattern: /groceries\.morrisons\.com\/products\/[^/?#]+\/\d+(?:$|[/?#])/i,
    extractProductId(url) {
      return /\/products\/[^/]+\/(\d+)/i.exec(url)?.[1] ?? null;
    },
  },
  ocado: {
    code: "ocado",
    name: "Ocado/M&S",
    supportsIndexing: true,
    supportsPriceScraping: false,
    defaultSitemapUrls: [
      "https://www.ocado.com/sitemaps/sitemap_index.xml",
      "https://www.ocado.com/sitemaps/sitemap-products-part1.xml",
    ],
    productUrlPattern: /ocado\.com\/products\/.+\/\d+(?:$|[/?#])/i,
    extractProductId(url) {
      return /\/products\/[^/]+\/(\d+)/i.exec(url)?.[1] ?? null;
    },
  },
  sainsburys: {
    code: "sainsburys",
    name: "Sainsbury's",
    supportsIndexing: true,
    supportsPriceScraping: false,
    defaultSitemapUrls: ["https://www.sainsburys.co.uk/sitemap.xml"],
    productUrlPattern: /sainsburys\.co\.uk\/gol-ui\/groceries\/[^?#]+\/c:\d+/i,
    pageType: "category",
    extractProductId() {
      return null;
    },
  },
  waitrose: {
    code: "waitrose",
    name: "Waitrose",
    supportsIndexing: true,
    supportsPriceScraping: false,
    defaultSitemapUrls: ["https://www.waitrose.com/sitemapIndex.xml"],
    productUrlPattern: /waitrose\.com\/ecom\/products\/[^/?#]+\/[\d-]+(?:$|[/?#])/i,
    extractProductId(url) {
      return /\/ecom\/products\/[^/]+\/([\d-]+)/i.exec(url)?.[1] ?? null;
    },
  },
};

function unsupported(code: SupermarketCode, name: string): Adapter {
  return {
    code,
    name,
    supportsIndexing: false,
    supportsPriceScraping: false,
    defaultSitemapUrls: [],
    productUrlPattern: /$a/,
    pageType: "product",
    extractProductId: () => null,
  };
}

function clampInt(value: unknown, fallback: number, min: number, max: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

function formatSupabaseError(error: SupabaseErrorLike | null | undefined): string {
  if (!error) return "Unknown Supabase error";
  return [
    error.message,
    error.code ? `code=${error.code}` : null,
    error.details ? `details=${error.details}` : null,
    error.hint ? `hint=${error.hint}` : null,
  ]
    .filter(Boolean)
    .join(" | ");
}

function runModeValue(value: unknown): "full" | "limited_test" | "resume" {
  return value === "limited_test" || value === "resume" ? value : "full";
}

function normalizeProductUrl(value: string, baseUrl: string): string | null {
  try {
    const url = new URL(value, baseUrl);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    for (const param of [...url.searchParams.keys()]) {
      if (/^(utm_|cid$|bid$|fbclid$|gclid$)/i.test(param)) {
        url.searchParams.delete(param);
      }
    }
    let normalized = url.toString();
    if (normalized.endsWith("/") && url.pathname !== "/") {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sainsburysCategoryIdFromUrl(url: string): string | null {
  return /\/c:(\d+)(?:$|[/?#])/i.exec(url)?.[1] ?? null;
}

function sainsburysProductId(product: Record<string, unknown>): string | null {
  return (
    stringValue(product.product_uid) ??
    stringValue(product.productUid) ??
    stringValue(product.sainId) ??
    stringValue(product.sku) ??
    null
  );
}

function sainsburysProductUrl(product: Record<string, unknown>): string | null {
  const candidate =
    stringValue(product.full_url) ??
    stringValue(product.fullUrl) ??
    stringValue(product.product_url) ??
    stringValue(product.productUrl) ??
    stringValue(product.url);
  if (!candidate) return null;
  return normalizeProductUrl(candidate, "https://www.sainsburys.co.uk");
}

function compactErrors(errors: SupermarketIndexResult["errors"]) {
  return errors.slice(0, SAINSBURYS_ERROR_SAMPLE_LIMIT);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function upsertIndexedPages(
  supabase: SupabaseClient,
  adapter: Adapter,
  runId: string,
  pages: IndexedPageCandidate[],
) {
  if (pages.length === 0) return { written: 0, productPages: 0 };

  let written = 0;
  let productPages = 0;
  for (let index = 0; index < pages.length; index += 500) {
    const batchPages = pages.slice(index, index + 500);
    const batch = batchPages.map((page) => ({
      run_id: runId,
      supermarket_code: adapter.code,
      supermarket_name: adapter.name,
      sitemap_url: page.sitemap_url,
      page_url: page.page_url,
      product_id: page.product_id,
      page_type: page.page_type,
      index_status: "indexed",
      scrape_status: page.page_type === "product" ? "pending" : "not_applicable",
      raw_index_data: {
        source: "railway_supermarket_indexer",
        supermarket_code: adapter.code,
        indexed_at: new Date().toISOString(),
        ...(page.raw_index_data ?? {}),
      },
      updated_at: new Date().toISOString(),
    }));
    const { error } = await supabase
      .from("supermarket_page_index")
      .upsert(batch, { onConflict: "supermarket_code,page_url" });
    if (error) throw new Error(formatSupabaseError(error));

    try {
      await classifyIndexedPageBatch(supabase, adapter, batchPages);
    } catch (error) {
      console.warn("[supermarketIndexer] Page scope classification failed for batch", {
        supermarket_code: adapter.code,
        run_id: runId,
        batch_size: batchPages.length,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    written += batch.length;
    productPages += batchPages.filter((page) => page.page_type === "product").length;
  }

  return { written, productPages };
}

function scopeInputForPage(adapter: Adapter, page: IndexedPageCandidate) {
  const raw = page.raw_index_data ?? {};
  const rawString = (key: string) => {
    const value = raw[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  return {
    supermarket_code: adapter.code,
    page_url: page.page_url,
    product_id: page.product_id,
    product_name: rawString("product_name") ?? rawString("name") ?? rawString("title"),
    brand: rawString("brand"),
    description: rawString("description"),
    category: rawString("category") ?? rawString("department"),
    category_path: rawString("category_path") ?? rawString("department_path") ?? rawString("breadcrumb"),
    source_category_id: rawString("source_category_id"),
    source_category_url: rawString("source_category_url"),
    raw_index_data: raw,
  };
}

async function classifyIndexedPageBatch(
  supabase: SupabaseClient,
  adapter: Adapter,
  pages: IndexedPageCandidate[],
) {
  const productPages = pages.filter((page) => page.page_type === "product");
  if (productPages.length === 0) return {
    eligible: 0,
    excluded: 0,
    review: 0,
    unknown: 0,
    skipped: pages.length,
  };

  const updates: Array<ScrapeScopeResult & { id: string; page_url: string }> = [];
  let skipped = 0;

  for (let index = 0; index < productPages.length; index += 50) {
    const chunk = productPages.slice(index, index + 50);
    const urls = chunk.map((page) => page.page_url);
    const { data, error } = await supabase
      .from("supermarket_page_index")
      .select("id,page_url,scrape_scope,scope_classifier_version,scope_input_hash,scope_reviewed_at")
      .eq("supermarket_code", adapter.code)
      .in("page_url", urls);
    if (error) throw new Error(formatSupabaseError(error));

    const rowsByUrl = new Map(
      ((data ?? []) as Array<{
        id: string;
        page_url: string;
        scrape_scope: string;
        scope_classifier_version: string | null;
        scope_input_hash: string | null;
        scope_reviewed_at: string | null;
      }>).map((row) => [row.page_url, row]),
    );

    for (const page of chunk) {
      const row = rowsByUrl.get(page.page_url);
      if (!row || row.scope_reviewed_at) {
        skipped += 1;
        continue;
      }
      const input = scopeInputForPage(adapter, page);
      const inputHash = buildScrapeScopeInputHash(input);
      if (
        row.scope_classifier_version === SCRAPE_SCOPE_CLASSIFIER_VERSION &&
        row.scope_input_hash === inputHash &&
        row.scrape_scope !== "unknown"
      ) {
        skipped += 1;
        continue;
      }
      updates.push({
        id: row.id,
        page_url: row.page_url,
        ...classifyScrapeScope(input),
      });
    }
  }

  const counts = { eligible: 0, excluded: 0, review: 0, unknown: 0, skipped };
  for (const update of updates) {
    counts[update.scrape_scope] += 1;
  }

  for (let index = 0; index < updates.length; index += 100) {
    const patch = updates.slice(index, index + 100).map((row) => ({
        id: row.id,
        supermarket_code: adapter.code,
        page_url: row.page_url,
        page_type: "product",
        scrape_scope: row.scrape_scope,
        scope_category: row.scope_category,
        scope_reason: row.scope_reason,
        scope_confidence: row.scope_confidence,
        scope_classifier_version: row.scope_classifier_version,
        scope_input_hash: row.scope_input_hash,
        scope_rule_id: row.scope_rule_id,
        scope_metadata: row.scope_metadata,
        scope_classified_at: new Date().toISOString(),
      }));
    const { error: updateError } = await supabase
      .from("supermarket_page_index")
      .upsert(patch, { onConflict: "id" });
    if (updateError) throw new Error(formatSupabaseError(updateError));
  }

  return counts;
}

async function fetchSainsburysShelfProducts(
  categoryUrl: string,
  categoryId: string,
  pageNumber: number,
) {
  const apiUrl = new URL("https://www.sainsburys.co.uk/groceries-api/gol-services/product/v1/product");
  apiUrl.searchParams.set("page_number", String(pageNumber));
  apiUrl.searchParams.set("page_size", "60");
  apiUrl.searchParams.set("sort_order", "-relevance");
  apiUrl.searchParams.set("filter[keyword]", "");
  apiUrl.searchParams.set("filter[category]", categoryId);
  apiUrl.searchParams.set("hfss_restricted", "false");
  apiUrl.searchParams.set("use_cached_results", "true");

  let text = "";
  let status = 0;
  let fetchMethod = "direct";

  try {
    const response = await fetch(apiUrl, {
      headers: {
        accept: "application/json,text/plain,*/*",
        referer: categoryUrl,
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        "x-requested-with": "XMLHttpRequest",
      },
      signal: AbortSignal.timeout(30_000),
    });
    status = response.status;
    text = await response.text();
    if (!response.ok && [403, 429, 500, 502, 503, 504].includes(response.status)) {
      throw new Error(`direct HTTP ${response.status}`);
    }
    if (!response.ok) {
      throw new Error(`Sainsbury product API failed with HTTP ${response.status}`);
    }
  } catch (directError) {
    const bright = await fetchViaBrightData(apiUrl.toString(), {
      render: false,
      rawTimeoutMs: 45_000,
      timeoutMs: 45_000,
      maxRetries: 1,
      emptyHtmlRetryCount: 1,
      emptyHtmlRetryDelayMs: 1_000,
    });
    status = bright.status;
    text = bright.html;
    fetchMethod = "brightdata_raw";
    if (!bright.ok || !text.trim()) {
      const directMessage = directError instanceof Error ? directError.message : String(directError);
      throw new Error(
        `Sainsbury product API failed via direct (${directMessage}) and Bright Data HTTP ${bright.status || "unknown"}`,
      );
    }
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("Sainsbury product API returned non-JSON response");
  }
  if (!isRecord(json)) {
    throw new Error("Sainsbury product API returned unexpected response shape");
  }

  const products = Array.isArray(json.products)
    ? json.products.filter(isRecord)
    : [];
  const controls = isRecord(json.controls) ? json.controls : {};
  const page = isRecord(controls.page) ? controls.page : {};
  const lastPage = Number(page.last);
  const totalRecordCount = Number(controls.total_record_count);

  return {
    products,
    lastPage: Number.isFinite(lastPage) && lastPage > 0 ? Math.floor(lastPage) : pageNumber,
    totalRecordCount: Number.isFinite(totalRecordCount) ? Math.floor(totalRecordCount) : null,
    fetchMethod,
  };
}

async function expandSainsburysShelfProducts(
  supabase: SupabaseClient,
  adapter: Adapter,
  runId: string,
  shelfPages: IndexedPageCandidate[],
  seenPages: Set<string>,
  seenProductIds: Set<string>,
  maxProductPages: number | null,
  errors: SupermarketIndexResult["errors"],
  invalidDetails: Parameters<typeof writeReconciliationDetails>[3],
): Promise<IndexedPageCandidate[]> {
  const productPages: IndexedPageCandidate[] = [];
  let flushedProductPages = 0;
  let shelvesProcessed = 0;
  let shelvesWithProducts = 0;
  let duplicateProducts = 0;
  let invalidProducts = 0;
  let failedShelves = 0;
  let loggedShelfErrors = 0;

  for (const shelf of shelfPages) {
    if (maxProductPages !== null && productPages.length >= maxProductPages) break;
    const categoryId = sainsburysCategoryIdFromUrl(shelf.page_url);
    if (!categoryId) {
      invalidDetails.push({
        detail_type: "invalid_url",
        page_url: shelf.page_url,
        normalized_page_url: shelf.normalized_page_url,
        source_url: shelf.sitemap_url,
        reason: "Sainsbury shelf URL did not include a category id",
        validation_error: "Missing /c:<categoryId> segment",
      });
      continue;
    }

    shelvesProcessed += 1;
    try {
      let pageNumber = 1;
      let lastPage = 1;
      let shelfProductCount = 0;
      do {
        const response = await fetchSainsburysShelfProducts(shelf.page_url, categoryId, pageNumber);
        lastPage = Math.max(pageNumber, response.lastPage);
        for (const product of response.products) {
          if (maxProductPages !== null && productPages.length >= maxProductPages) break;
          const productId = sainsburysProductId(product);
          const productUrl = sainsburysProductUrl(product);
          if (!productUrl) {
            invalidProducts += 1;
            invalidDetails.push({
              detail_type: "invalid_url",
              page_url: stringValue(product.full_url) ?? stringValue(product.fullUrl) ?? null,
              source_url: shelf.page_url,
              reason: "Sainsbury product API row did not include a usable product URL",
              metadata: {
                source_category_id: categoryId,
                product_uid: productId,
              },
            });
            continue;
          }
          if (seenPages.has(productUrl) || (productId !== null && seenProductIds.has(productId))) {
            duplicateProducts += 1;
            continue;
          }

          seenPages.add(productUrl);
          if (productId !== null) seenProductIds.add(productId);
          shelfProductCount += 1;
          productPages.push({
            page_url: productUrl,
            normalized_page_url: productUrl,
            product_id: productId,
            sitemap_url: shelf.sitemap_url,
            page_type: "product",
            raw_index_data: {
              source: "sainsburys_shelf_product_indexer",
              source_category_url: shelf.page_url,
              source_category_id: categoryId,
              product_name: stringValue(product.name),
              image_url: stringValue(product.image),
              total_record_count: response.totalRecordCount,
              fetch_method: response.fetchMethod,
            },
          });
        }
        pageNumber += 1;
      } while (pageNumber <= lastPage && (maxProductPages === null || productPages.length < maxProductPages));

      if (shelfProductCount > 0) shelvesWithProducts += 1;
    } catch (error) {
      failedShelves += 1;
      const item = {
        url: shelf.page_url,
        http_status: null,
        error_code: "SAINSBURYS_SHELF_PRODUCT_INDEX_FAILED",
        error_message: error instanceof Error ? error.message : String(error),
      };
      if (errors.length < SAINSBURYS_ERROR_SAMPLE_LIMIT) errors.push(item);
      if (loggedShelfErrors < SAINSBURYS_ERROR_SAMPLE_LIMIT) {
        loggedShelfErrors += 1;
        await logIndexError(supabase, adapter, runId, item);
      }
    }

    if (productPages.length - flushedProductPages >= 500) {
      const pagesToFlush = productPages.slice(flushedProductPages);
      await upsertIndexedPages(supabase, adapter, runId, pagesToFlush);
      flushedProductPages = productPages.length;
      await updateRun(supabase, runId, {
        pages_pending: flushedProductPages,
        last_message: `Sainsbury's checkpoint wrote ${flushedProductPages} product URL(s) while expanding shelves`,
      });
    }

    if (shelvesProcessed % 25 === 0) {
      await updateRun(supabase, runId, {
        pages_indexed: shelfPages.length + productPages.length,
        source_urls_discovered: shelfPages.length + productPages.length,
        unique_urls_discovered: shelfPages.length + productPages.length,
        duplicate_urls_count: duplicateProducts,
        invalid_urls_count: invalidDetails.length,
        checkpoint_metadata: {
          sainsburys_shelves_processed: shelvesProcessed,
          sainsburys_shelves_total: shelfPages.length,
          sainsburys_shelves_with_products: shelvesWithProducts,
          sainsburys_product_urls_discovered: productPages.length,
          sainsburys_duplicate_product_urls: duplicateProducts,
          sainsburys_invalid_product_rows: invalidProducts,
          sainsburys_failed_shelf_count: failedShelves,
          failed_source_segments: compactErrors(errors),
        },
        last_message: `Sainsbury's expanded ${shelvesProcessed}/${shelfPages.length} shelf URL(s), found ${productPages.length} product page URL(s)`,
      });
    }
    await delay(150);
  }

  if (productPages.length > flushedProductPages) {
    await upsertIndexedPages(supabase, adapter, runId, productPages.slice(flushedProductPages));
  }

  await updateRun(supabase, runId, {
    checkpoint_metadata: {
      sainsburys_shelves_processed: shelvesProcessed,
      sainsburys_shelves_total: shelfPages.length,
      sainsburys_shelves_with_products: shelvesWithProducts,
      sainsburys_product_urls_discovered: productPages.length,
      sainsburys_duplicate_product_urls: duplicateProducts,
      sainsburys_invalid_product_rows: invalidProducts,
      sainsburys_failed_shelf_count: failedShelves,
      failed_source_segments: compactErrors(errors),
    },
    last_message: `Sainsbury's shelf-to-product expansion found ${productPages.length} product page URL(s) from ${shelvesProcessed} shelf URL(s)`,
  });

  return productPages;
}

function envSitemapUrls(code: SupermarketCode): string[] | null {
  const key = `${code.toUpperCase()}_SITEMAP_URLS`;
  const raw = process.env[key];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((url: unknown) => typeof url === "string" && url.trim());
  } catch {
    return raw
      .split(",")
      .map((url: string) => url.trim())
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

async function fetchSourceViaBrightData(url: string, adapter: Adapter) {
  try {
    const bright = await fetchViaBrightData(url, {
      render: false,
      rawTimeoutMs: 45_000,
      timeoutMs: 45_000,
      maxRetries: 1,
      emptyHtmlRetryCount: 0,
    });
    if (bright.ok && bright.html.trim()) {
      return {
        ok: true,
        status: bright.status,
        text: bright.html,
        fetchMethod: "brightdata_raw",
        contentType: bright.contentType ?? null,
      };
    }
  } catch (error) {
    console.warn("[supermarketIndexer] Bright Data sitemap fallback failed", {
      supermarket_code: adapter.code,
      url,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return null;
}

async function fetchSourceText(url: string, adapter: Adapter) {
  const response = await fetch(url, {
    headers: {
      accept: "application/xml,text/xml,text/plain,*/*",
      "user-agent": "CetiaDataServices/1.0 supermarket page indexer",
    },
    signal: AbortSignal.timeout(45_000),
  });
  const text = await response.text();
  if (response.ok) {
    if (isLikelySitemap(url) && !/<loc\b/i.test(text)) {
      const bright = await fetchSourceViaBrightData(url, adapter);
      if (bright && /<loc\b/i.test(bright.text)) return bright;
    }
    return {
      ok: true,
      status: response.status,
      text,
      fetchMethod: "direct",
      contentType: response.headers.get("content-type"),
    };
  }

  if ([401, 403, 429].includes(response.status)) {
    const bright = await fetchSourceViaBrightData(url, adapter);
    if (bright) return bright;
  }

  return {
    ok: false,
    status: response.status,
    text,
    fetchMethod: "direct",
    contentType: response.headers.get("content-type"),
  };
}

async function createRun(
  supabase: SupabaseClient,
  adapter: Adapter,
  inputRunId: unknown,
  maxPages: number | null,
  runMode: string,
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
        run_mode: runMode,
      },
      started_at: new Date().toISOString(),
      last_heartbeat_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error || !data) throw new Error(error ? formatSupabaseError(error) : "Failed to create index run");
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
  if (error) throw new Error(formatSupabaseError(error));
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

async function countDatabasePages(supabase: SupabaseClient, code: SupermarketCode) {
  const { count, error } = await supabase
    .from("supermarket_page_index")
    .select("id", { count: "exact", head: true })
    .eq("supermarket_code", code);
  if (error) throw new Error(formatSupabaseError(error));
  return count ?? 0;
}

async function loadDatabasePages(supabase: SupabaseClient, code: SupermarketCode) {
  const rows: Array<{ page_url: string; product_id: string | null; page_type: string | null }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("supermarket_page_index")
      .select("page_url,product_id,page_type")
      .eq("supermarket_code", code)
      .order("page_url", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(formatSupabaseError(error));
    rows.push(...((data ?? []) as Array<{ page_url: string; product_id: string | null; page_type: string | null }>));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

async function writeReconciliationDetails(
  supabase: SupabaseClient,
  runId: string,
  code: SupermarketCode,
  details: Array<{
    detail_type: string;
    page_url?: string | null;
    normalized_page_url?: string | null;
    product_id?: string | null;
    source_url?: string | null;
    reason?: string | null;
    validation_error?: string | null;
    database_error?: string | null;
    metadata?: Record<string, unknown>;
  }>,
) {
  if (details.length === 0) return;
  for (let index = 0; index < details.length; index += 500) {
    const batch = details.slice(index, index + 500).map((detail) => ({
      run_id: runId,
      supermarket_code: code,
      detail_type: detail.detail_type,
      page_url: detail.page_url ?? null,
      normalized_page_url: detail.normalized_page_url ?? null,
      product_id: detail.product_id ?? null,
      source_url: detail.source_url ?? null,
      reason: detail.reason ?? null,
      validation_error: detail.validation_error ?? null,
      database_error: detail.database_error ?? null,
      metadata: detail.metadata ?? {},
    }));
    const { error } = await supabase
      .from("supermarket_index_reconciliation_details")
      .insert(batch);
    if (error) throw new Error(formatSupabaseError(error));
  }
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
      source_control_total: 0,
      unique_urls_discovered: 0,
      database_total_before: 0,
      database_total_after: 0,
      existing_urls_count: 0,
      new_urls_inserted: 0,
      urls_updated: 0,
      duplicate_urls_count: 0,
      invalid_urls_count: 0,
      missing_url_count: 0,
      unexpected_extra_count: 0,
      reconciliation_status: "failed",
      message: `${adapter.name} indexing is not implemented yet`,
    };
  }

  const supabase = createSupabaseServiceClient();
  const runMode = runModeValue(input.run_mode);
  const requestedMaxPages =
    input.max_pages == null || input.max_pages === ""
      ? null
      : clampInt(input.max_pages, 1000, 1, 100_000);
  const maxPages = runMode === "limited_test" ? requestedMaxPages ?? 1000 : null;
  const runId = await createRun(supabase, adapter, input.run_id, maxPages, runMode);
  const databaseTotalBefore = await countDatabasePages(supabase, adapter.code);
  await updateRun(supabase, runId, {
    status: "indexing",
    phase: "page_indexing",
    started_at: new Date().toISOString(),
    last_message: `${adapter.name} page indexing running`,
    database_total_before: databaseTotalBefore,
    reconciliation_status: null,
    source_exhausted: false,
    is_partial: false,
    partial_reason: null,
  });

  const requestedUrls = Array.isArray(input.sitemap_urls)
    ? input.sitemap_urls.filter((url): url is string => typeof url === "string" && url.trim().length > 0)
    : null;
  const sourceSitemapUrls =
    requestedUrls ??
    [...(envSitemapUrls(code) ?? []), ...adapter.defaultSitemapUrls].filter(
      (url, index, urls) => urls.indexOf(url) === index,
    );
  const queue = [...sourceSitemapUrls];
  const seenSitemaps = new Set<string>();
  const seenPages = new Set<string>();
  const pages: IndexedPageCandidate[] = [];
  const errors: SupermarketIndexResult["errors"] = [];
  const invalidDetails: Parameters<typeof writeReconciliationDetails>[3] = [];
  let sourceUrlsDiscovered = 0;
  let duplicateUrlsCount = 0;
  let sitemapUrlsProcessed = 0;
  let limitReached = false;
  let sainsburysProductPageCount: number | null = null;

  while (queue.length > 0 && seenSitemaps.size < 5000) {
    const sitemapUrl = queue.shift()!;
    if (seenSitemaps.has(sitemapUrl)) continue;
    seenSitemaps.add(sitemapUrl);
    sitemapUrlsProcessed += 1;

    try {
      const source = await fetchSourceText(sitemapUrl, adapter);
      const text = source.text;
      if (!source.ok) {
        const item = {
          url: sitemapUrl,
          http_status: source.status,
          error_code: "SUPERMARKET_SITEMAP_FETCH_FAILED",
          error_message: `${adapter.name} sitemap fetch failed with HTTP ${source.status}`,
        };
        errors.push(item);
        await logIndexError(supabase, adapter, runId, item);
        continue;
      }

      const locs = locsFromXml(text);
      if (locs.length === 0) {
        const item = {
          url: sitemapUrl,
          http_status: source.status,
          error_code: "SUPERMARKET_SITEMAP_NO_LOCS",
          error_message: `${adapter.name} sitemap returned no <loc> entries via ${source.fetchMethod}`,
        };
        errors.push(item);
        await logIndexError(supabase, adapter, runId, item);
        continue;
      }

      for (const loc of locs) {
        if (adapter.productUrlPattern.test(loc)) {
          sourceUrlsDiscovered += 1;
          const cleanUrl = normalizeProductUrl(loc, sitemapUrl);
          if (!cleanUrl) {
            invalidDetails.push({
              detail_type: "invalid_url",
              page_url: loc,
              source_url: sitemapUrl,
              reason: "Malformed product URL",
              validation_error: "URL parser rejected source loc",
            });
            continue;
          }
          if (!seenPages.has(cleanUrl)) {
            seenPages.add(cleanUrl);
            pages.push({
              page_url: cleanUrl,
              normalized_page_url: cleanUrl,
              product_id: adapter.extractProductId(cleanUrl),
              sitemap_url: sitemapUrl,
              page_type: adapter.pageType ?? "product",
            });
            if (maxPages !== null && adapter.code !== "sainsburys" && pages.length >= maxPages) {
              limitReached = true;
              break;
            }
          } else {
            duplicateUrlsCount += 1;
          }
        } else if (isLikelySitemap(loc) && !seenSitemaps.has(loc)) {
          queue.push(loc);
        }
      }

      if (sitemapUrlsProcessed % 10 === 0) {
        await updateRun(supabase, runId, {
          pages_indexed: pages.length,
          source_urls_discovered: sourceUrlsDiscovered,
          unique_urls_discovered: pages.length,
          duplicate_urls_count: duplicateUrlsCount,
          invalid_urls_count: invalidDetails.length,
          sitemap_count_processed: sitemapUrlsProcessed,
          checkpoint_metadata: {
            completed_sitemap_urls: [...seenSitemaps],
            pending_sitemap_urls: queue,
            urls_discovered_so_far: pages.length,
            failed_source_segments: errors,
            last_fetch_method: source.fetchMethod,
          },
          last_message: `${adapter.name} indexing scanned ${sitemapUrlsProcessed} sitemap(s), found ${pages.length} product page(s)`,
        });
      }
      if (limitReached) break;
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

  const existingRowsBefore = await loadDatabasePages(supabase, adapter.code);
  const existingUrlSet = new Set(
    existingRowsBefore
      .map((row) => normalizeProductUrl(row.page_url, adapter.defaultSitemapUrls[0] ?? "https://example.com"))
      .filter((url): url is string => Boolean(url)),
  );
  for (const url of existingUrlSet) {
    seenPages.add(url);
  }
  const seenProductIds = new Set(
    existingRowsBefore
      .map((row) => row.product_id)
      .filter((productId): productId is string => Boolean(productId)),
  );
  const existingProductPageCount = existingRowsBefore.filter((row) => row.page_type === "product").length;

  if (adapter.code === "sainsburys" && pages.length > 0) {
    const shelfPages = pages.filter((page) => page.page_type === "category");
    const productLimit = maxPages;
    const productPages = await expandSainsburysShelfProducts(
      supabase,
      adapter,
      runId,
      shelfPages,
      seenPages,
      seenProductIds,
      productLimit,
      errors,
      invalidDetails,
    );
    if (productLimit !== null && productPages.length >= productLimit) {
      limitReached = true;
    }
    pages.push(...productPages);
    sourceUrlsDiscovered += productPages.length;
    sainsburysProductPageCount = productPages.length;
  }

  const sourceExhausted = queue.length === 0 && !limitReached && errors.length === 0 && seenSitemaps.size < 5000;
  const effectiveSainsburysProductPageCount =
    adapter.code === "sainsburys" ? existingProductPageCount + (sainsburysProductPageCount ?? 0) : null;
  const sourceControlTotal =
    adapter.code === "sainsburys" && effectiveSainsburysProductPageCount !== null
      ? pages.filter((page) => page.page_type === "category").length + effectiveSainsburysProductPageCount
      : pages.length;
  const existingUrlsCount = pages.filter((page) => existingUrlSet.has(page.normalized_page_url)).length;
  const newUrlsInserted = pages.length - existingUrlsCount;
  const urlsUpdated = existingUrlsCount;

  const writtenResult = await upsertIndexedPages(supabase, adapter, runId, pages);
  const written = writtenResult.written;
  const writtenProductPages = writtenResult.productPages;

  const databaseRowsAfter = await loadDatabasePages(supabase, adapter.code);
  const databaseTotalAfter = databaseRowsAfter.length;
  const databaseProductRowsAfter = databaseRowsAfter.filter((row) => row.page_type === "product").length;
  const { data: scopeRows, error: scopeError } = await supabase
    .from("supermarket_page_index")
    .select("scrape_scope")
    .eq("supermarket_code", adapter.code)
    .eq("page_type", "product");
  if (scopeError) throw new Error(formatSupabaseError(scopeError));
  const scopeSummary = {
    eligible: 0,
    excluded: 0,
    review: 0,
    unknown: 0,
  };
  for (const row of (scopeRows ?? []) as Array<{ scrape_scope: keyof typeof scopeSummary }>) {
    if (row.scrape_scope in scopeSummary) scopeSummary[row.scrape_scope] += 1;
  }
  const expectedUrlSet = new Set(pages.map((page) => page.normalized_page_url));
  if (adapter.code === "sainsburys") {
    for (const url of existingUrlSet) expectedUrlSet.add(url);
  }
  const databaseUrlSet = new Set(
    databaseRowsAfter
      .map((row) => normalizeProductUrl(row.page_url, adapter.defaultSitemapUrls[0] ?? "https://example.com"))
      .filter((url): url is string => Boolean(url)),
  );
  const missingUrls = pages.filter((page) => !databaseUrlSet.has(page.normalized_page_url));
  const unexpectedExtras = [...databaseUrlSet].filter((url) => !expectedUrlSet.has(url));
  const reconciliationDetails: Parameters<typeof writeReconciliationDetails>[3] = [
    ...invalidDetails,
    ...missingUrls.slice(0, 5000).map((page) => ({
      detail_type: "missing_url",
      page_url: page.page_url,
      normalized_page_url: page.normalized_page_url,
      product_id: page.product_id,
      source_url: page.sitemap_url,
      reason: "Expected source URL was not present in supermarket_page_index after upsert",
    })),
    ...unexpectedExtras.slice(0, 5000).map((url) => ({
      detail_type: "unexpected_extra_url",
      page_url: url,
      normalized_page_url: url,
      reason: "Database URL was not present in latest source traversal; retained for review",
    })),
  ];
  await writeReconciliationDetails(supabase, runId, adapter.code, reconciliationDetails);

  let reconciliationStatus = "reconciled";
  let status = "indexed";
  let phase = "page_index_reconciled";
  let isPartial = false;
  let partialReason: string | null = null;
  let message =
    adapter.code === "sainsburys"
      ? `${adapter.name} shelf-to-product source reconciled: ${effectiveSainsburysProductPageCount ?? 0} product URL(s), ${databaseTotalAfter} indexed URL(s)`
      : `${adapter.name} source reconciled: ${sourceControlTotal} source URL(s), ${databaseTotalAfter} indexed URL(s)`;

  if (
    pages.length === 0 ||
    (adapter.code === "sainsburys" && (effectiveSainsburysProductPageCount ?? 0) === 0)
  ) {
    status = "failed";
    phase = "page_index_failed";
    reconciliationStatus = errors.length > 0 ? "partial_source_failure" : "failed";
    message =
      errors.length > 0
        ? `${adapter.name} indexing failed before product URLs were discovered`
        : adapter.code === "sainsburys"
          ? `${adapter.name} shelf-to-product indexing found no product page URLs`
          : `${adapter.name} indexing found no product page URLs`;
  } else if (limitReached) {
    status = "partial_limit_reached";
    phase = "page_index_partial";
    reconciliationStatus = "partial_limit_reached";
    isPartial = true;
    partialReason = `Run mode ${runMode} stopped after max_pages=${maxPages}`;
    message = `${adapter.name} limited indexing stopped at ${pages.length} URL(s); source was not fully exhausted`;
  } else if (errors.length > 0 || !sourceExhausted) {
    status = "partial_source_failure";
    phase = "page_index_partial";
    reconciliationStatus = "partial_source_failure";
    isPartial = true;
    partialReason = errors[0]?.error_message ?? "Source traversal did not exhaust all sitemap URLs";
    message = `${adapter.name} indexing is partial because one or more source segments failed`;
  } else if (missingUrls.length > 0) {
    status = "failed";
    phase = "page_index_reconciliation_failed";
    reconciliationStatus = "control_total_mismatch";
    message = `${adapter.name} reconciliation mismatch: ${missingUrls.length} expected URL(s) missing`;
  } else if (invalidDetails.length > 0) {
    reconciliationStatus = "reconciled_with_exclusions";
    message = `${adapter.name} source reconciled with ${invalidDetails.length} invalid URL exclusion(s)`;
  }

  await updateRun(supabase, runId, {
    status,
    phase,
    pages_indexed: adapter.code === "sainsburys" ? databaseProductRowsAfter : written,
    pages_pending: adapter.code === "sainsburys" ? databaseProductRowsAfter : writtenProductPages,
    source_reported_total: sourceControlTotal,
    source_control_total: sourceControlTotal,
    sitemap_count_expected: seenSitemaps.size + queue.length,
    sitemap_count_processed: sitemapUrlsProcessed,
    source_urls_discovered: sourceUrlsDiscovered,
    unique_urls_discovered:
      adapter.code === "sainsburys" && effectiveSainsburysProductPageCount !== null
        ? effectiveSainsburysProductPageCount
        : pages.length,
    existing_urls_count: existingUrlsCount,
    new_urls_inserted: newUrlsInserted,
    urls_updated: urlsUpdated,
    duplicate_urls_count: duplicateUrlsCount,
    invalid_urls_count: invalidDetails.length,
    excluded_urls_count: invalidDetails.length,
    failed_urls_count: errors.length,
    database_total_before: databaseTotalBefore,
    database_total_after: databaseTotalAfter,
    missing_url_count: missingUrls.length,
    unexpected_extra_count: unexpectedExtras.length,
    reconciliation_status: reconciliationStatus,
    reconciliation_message: message,
    source_exhausted: sourceExhausted,
    is_partial: isPartial,
    partial_reason: partialReason,
    checkpoint_metadata: {
      completed_sitemap_urls: [...seenSitemaps],
      pending_sitemap_urls: queue,
      urls_discovered_so_far: pages.length,
      sainsburys_product_urls_discovered: sainsburysProductPageCount,
      sainsburys_effective_product_urls: effectiveSainsburysProductPageCount,
      scrape_scope_summary: scopeSummary,
      scrape_scope_classifier_version: SCRAPE_SCOPE_CLASSIFIER_VERSION,
      failed_source_segments: compactErrors(errors),
      details_limited_to: 5000,
    },
    errors_count: errors.length,
    last_message: message,
    last_error: errors[0]?.error_message ?? (pages.length > 0 ? null : message),
    finished_at: new Date().toISOString(),
  });

  return {
    success: adapter.code === "sainsburys" ? (effectiveSainsburysProductPageCount ?? 0) > 0 : pages.length > 0,
    supermarket_code: adapter.code,
    supermarket_name: adapter.name,
    run_id: runId,
    pages_found:
      adapter.code === "sainsburys" && effectiveSainsburysProductPageCount !== null
        ? effectiveSainsburysProductPageCount
        : pages.length,
    pages_inserted_or_updated: written,
    sitemap_urls_processed: sitemapUrlsProcessed,
    errors,
    source_control_total: sourceControlTotal,
    unique_urls_discovered:
      adapter.code === "sainsburys" && effectiveSainsburysProductPageCount !== null
        ? effectiveSainsburysProductPageCount
        : pages.length,
    database_total_before: databaseTotalBefore,
    database_total_after: databaseTotalAfter,
    existing_urls_count: existingUrlsCount,
    new_urls_inserted: newUrlsInserted,
    urls_updated: urlsUpdated,
    duplicate_urls_count: duplicateUrlsCount,
    invalid_urls_count: invalidDetails.length,
    missing_url_count: missingUrls.length,
    unexpected_extra_count: unexpectedExtras.length,
    reconciliation_status: reconciliationStatus,
    message,
  };
}
