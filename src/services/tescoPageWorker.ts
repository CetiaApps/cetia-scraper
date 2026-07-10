import { randomUUID } from "node:crypto";
import { createSupabaseServiceClient } from "./supabase.js";
import {
  scrapeTescoProductPages,
  type TescoProductPageInput,
  type TescoProductPageItem,
  type TescoProductPageError,
  type TescoProductPageScrapeStats,
} from "../crawlers/tescoProductPageCrawler.js";
import { getTescoProductFetchMode, type BrightDataFetchMode } from "./brightdata.js";

const SUPERMARKET_CODE = "tesco";
const SUPERMARKET_NAME = "Tesco";
const STALE_CLAIM_MINUTES = 10;

type SupabaseClient = ReturnType<typeof createSupabaseServiceClient>;

interface WorkerPage {
  id: string;
  page_url: string;
  product_id: string | null;
  scrape_attempt_count: number | null;
  max_attempts: number | null;
  run_id?: string | null;
}

export interface TescoWorkerInput {
  run_id: string;
  batch_size?: unknown;
  max_concurrency?: unknown;
  max_runtime_seconds?: unknown;
  allow_render_fallback?: unknown;
  fetch_mode?: unknown;
  write_to_productscrapped?: unknown;
  stop_when_no_pages?: unknown;
  adopt_global_pending_pages?: unknown;
  include_failed?: unknown;
  recheck_after_days?: unknown;
  force?: unknown;
  debug?: unknown;
}

export interface TescoWorkerResult {
  run_id: string;
  worker_id: string;
  started_at: string;
  finished_at: string;
  elapsed_ms: number;
  loops: number;
  pages_claimed: number;
  pages_scraped: number;
  pages_failed: number;
  items_upserted: number;
  productscrapped_written: number;
  pending_remaining: number;
  errors_count: number;
  adopted_pages: number;
  stats: TescoProductPageScrapeStats;
  stopped_reason: "max_runtime_reached" | "no_pages_remaining" | "cancelled" | "error";
  message: string;
}

export class WorkerAlreadyRunningError extends Error {
  activePages: number;

  constructor(activePages: number) {
    super(`Tesco worker already has ${activePages} active page claim(s) for this run`);
    this.name = "WorkerAlreadyRunningError";
    this.activePages = activePages;
  }
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

function boolValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function fetchModeValue(value: unknown): BrightDataFetchMode {
  return ["raw_first", "render_first", "raw_only", "render_only"].includes(String(value))
    ? (value as BrightDataFetchMode)
    : getTescoProductFetchMode();
}

function emptyStats(): TescoProductPageScrapeStats {
  return {
    raw_fetch_success: 0,
    render_fetch_success: 0,
    producttype_success: 0,
    jsonld_success: 0,
    nextdata_success: 0,
    meta_fallback_success: 0,
    parse_failed: 0,
    empty_html: 0,
    brightdata_retryable_errors: 0,
  };
}

function addStats(
  target: TescoProductPageScrapeStats,
  source: TescoProductPageScrapeStats | undefined,
) {
  if (!source) return;
  for (const key of Object.keys(target) as Array<keyof TescoProductPageScrapeStats>) {
    target[key] += Number(source[key] ?? 0);
  }
}

function requestTimeoutFromRuntime(maxRuntimeSeconds: number): number {
  return maxRuntimeSeconds <= 90
    ? Math.min(Math.max(Math.floor(maxRuntimeSeconds * 500), 5_000), 45_000)
    : 0;
}

function safeErrorMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message.slice(0, 1000);
}

function backoffMinutes(attemptCount: number): number {
  return Math.min(180, Math.max(5, 5 * 2 ** Math.max(0, attemptCount - 1)));
}

function chunkArray<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function productScrappedPayload(
  item: TescoProductPageItem,
  runId: string,
  page: WorkerPage | undefined,
) {
  return {
    supermarket_name: SUPERMARKET_NAME,
    supermarket_code: SUPERMARKET_CODE,
    query: item.product_name ?? item.product_title ?? item.product_id ?? item.product_url,
    product_name: item.product_name,
    product_title: item.product_title,
    brand: item.brand,
    description: item.description,
    price: item.price,
    price_text: item.price_text,
    currency: item.currency ?? "GBP",
    unit_price: item.unit_price,
    unit_price_value: item.unit_price_value,
    unit_price_unit: item.unit_price_unit,
    offer_text: item.offer_text,
    promotion_text: item.promotion_text,
    availability: item.availability,
    in_stock: item.in_stock,
    product_url: item.product_url,
    product_id: item.product_id ?? page?.product_id ?? null,
    sku: item.sku,
    gtin: item.gtin,
    barcode: item.barcode,
    category: item.category,
    category_path: item.category_path,
    raw_data: item.raw_data,
    scrappeddate: new Date().toISOString(),
    apify_run_id: runId,
    created_at: new Date().toISOString(),
  };
}

async function logScrapeError(
  supabase: SupabaseClient,
  input: {
    runId: string;
    pageIndexId?: string | null;
    url?: string | null;
    httpStatus?: number | null;
    code?: string | null;
    message: string;
    metadata?: Record<string, unknown>;
    phase?: string;
  },
) {
  const { error } = await supabase.from("supermarket_price_scrape_errors").insert({
    run_id: input.runId,
    page_index_id: input.pageIndexId ?? null,
    supermarket_code: SUPERMARKET_CODE,
    phase: input.phase ?? "scraping",
    severity: "error",
    url: input.url ?? null,
    http_status: input.httpStatus ?? null,
    error_code: input.code ?? null,
    error_message: input.message,
    metadata: input.metadata ?? {},
  });

  if (error) {
    console.warn("[tescoPageWorker] Failed to log scrape error", {
      run_id: input.runId,
      url: input.url,
      code: error.code,
      message: error.message,
    });
  }
}

async function refreshRunCounts(
  supabase: SupabaseClient,
  runId: string,
  patch: Record<string, unknown> = {},
) {
  const { data, error: rpcError } = await supabase
    .rpc("refresh_tesco_scrape_run_counts", { p_run_id: runId })
    .single();
  if (rpcError) throw new Error(rpcError.message);
  const counts = data as {
    pages_indexed: number;
    pages_pending: number;
    pages_scraping: number;
    pages_scraped: number;
    pages_failed: number;
    items_upserted: number;
    errors_count: number;
  };

  const updatePayload = {
    last_heartbeat_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...patch,
  };

  const { error } = await supabase
    .from("supermarket_price_scrape_runs")
    .update(updatePayload)
    .eq("id", runId);
  if (error) throw new Error(error.message);

  return {
    indexed: counts.pages_indexed ?? 0,
    pending: counts.pages_pending ?? 0,
    scraping: counts.pages_scraping ?? 0,
    scraped: counts.pages_scraped ?? 0,
    failed: counts.pages_failed ?? 0,
    items: counts.items_upserted ?? 0,
    errors: counts.errors_count ?? 0,
  };
}

async function resetStalePages(
  supabase: SupabaseClient,
  runId: string,
  includeGlobal = false,
): Promise<number> {
  const staleBefore = new Date(Date.now() - STALE_CLAIM_MINUTES * 60_000).toISOString();
  let query = supabase
    .from("supermarket_page_index")
    .update({
      scrape_status: "pending",
      claimed_at: null,
      claimed_by: null,
      last_error: "Reset stale Tesco worker claim",
      updated_at: new Date().toISOString(),
    })
    .eq("supermarket_code", SUPERMARKET_CODE)
    .eq("scrape_status", "scraping")
    .is("last_scraped_at", null)
    .lt("claimed_at", staleBefore);

  if (!includeGlobal) query = query.eq("run_id", runId);

  const { data, error } = await query.select("id");

  if (error) throw new Error(error.message);
  return data?.length ?? 0;
}

async function resetActivePages(supabase: SupabaseClient, runId: string): Promise<number> {
  const { data, error } = await supabase
    .from("supermarket_page_index")
    .update({
      scrape_status: "pending",
      claimed_at: null,
      claimed_by: null,
      last_error: "Reset active Tesco worker claim by recovery request",
      updated_at: new Date().toISOString(),
    })
    .eq("supermarket_code", SUPERMARKET_CODE)
    .eq("run_id", runId)
    .eq("scrape_status", "scraping")
    .is("last_scraped_at", null)
    .select("id");

  if (error) throw new Error(error.message);
  return data?.length ?? 0;
}

async function activeClaimCount(
  supabase: SupabaseClient,
  runId: string,
  includeGlobal = false,
): Promise<number> {
  const activeSince = new Date(Date.now() - STALE_CLAIM_MINUTES * 60_000).toISOString();
  let query = supabase
    .from("supermarket_page_index")
    .select("*", { count: "exact", head: true })
    .eq("supermarket_code", SUPERMARKET_CODE)
    .eq("scrape_status", "scraping")
    .gte("claimed_at", activeSince);

  if (!includeGlobal) query = query.eq("run_id", runId);

  const { count, error } = await query;

  if (error) throw new Error(error.message);
  return count ?? 0;
}

function eligibleForScrape(page: WorkerPage): boolean {
  return Number(page.scrape_attempt_count ?? 0) < Number(page.max_attempts ?? 3);
}

async function claimPages(
  supabase: SupabaseClient,
  runId: string,
  workerId: string,
  batchSize: number,
  scope: "run" | "global" = "run",
): Promise<WorkerPage[]> {
  if (scope === "run") {
    const { data, error } = await supabase.rpc("claim_tesco_product_pages", {
      p_run_id: runId,
      p_batch_size: batchSize,
      p_worker_id: workerId,
      p_stale_after_minutes: STALE_CLAIM_MINUTES,
    });
    if (error) throw new Error(error.message);
    return (data ?? []) as WorkerPage[];
  }

  const now = new Date().toISOString();
  let query = supabase
    .from("supermarket_page_index")
    .select("id,run_id,page_url,product_id,scrape_attempt_count,max_attempts")
    .eq("supermarket_code", SUPERMARKET_CODE)
    .in("scrape_status", ["pending", "failed"])
    .or(`next_scrape_after.is.null,next_scrape_after.lte.${now}`)
    .order("updated_at", { ascending: true })
    .limit(batchSize * 5);

  const { data, error } = await query;

  if (error) throw new Error(error.message);

  const pages = ((data ?? []) as WorkerPage[])
    .filter(eligibleForScrape)
    .slice(0, batchSize);

  if (pages.length === 0) return [];

  const { data: claimed, error: claimError } = await supabase
    .from("supermarket_page_index")
    .update({
      run_id: runId,
      scrape_status: "scraping",
      claimed_at: new Date().toISOString(),
      claimed_by: workerId,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .in(
      "id",
      pages.map((page) => page.id),
    )
    .select("id,run_id,page_url,product_id,scrape_attempt_count,max_attempts");

  if (claimError) throw new Error(claimError.message);
  return (claimed ?? []) as WorkerPage[];
}

async function markPageFailed(
  supabase: SupabaseClient,
  runId: string,
  page: WorkerPage,
  error: TescoProductPageError | null,
  fallbackMessage: string,
) {
  const nextAttempt = Number(page.scrape_attempt_count ?? 0) + 1;
  const maxAttempts = Number(page.max_attempts ?? 3);
  const message = (error?.error_message || fallbackMessage).slice(0, 1000);
  const nextScrapeAfter =
    nextAttempt >= maxAttempts
      ? null
      : new Date(Date.now() + backoffMinutes(nextAttempt) * 60_000).toISOString();

  const { error: updateError } = await supabase
    .from("supermarket_page_index")
    .update({
      scrape_status: "failed",
      scrape_attempt_count: nextAttempt,
      last_http_status: error?.http_status ?? null,
      last_error: message,
      last_error_at: new Date().toISOString(),
      next_scrape_after: nextScrapeAfter,
      claimed_by: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", page.id);
  if (updateError) throw new Error(updateError.message);

  await logScrapeError(supabase, {
    runId,
    pageIndexId: page.id,
    url: page.page_url,
    httpStatus: error?.http_status ?? null,
    code: error?.error_code ?? "TESCO_WORKER_PAGE_FAILED",
    message,
    metadata: error?.metadata,
  });
}

async function processBatch(
  supabase: SupabaseClient,
  runId: string,
  pages: WorkerPage[],
  maxConcurrency: number,
  allowRenderFallback: boolean,
  fetchMode: BrightDataFetchMode,
  debug: boolean,
  writeToProductscrapped: boolean,
  requestTimeoutMs: number,
) {
  const startedAt = Date.now();
  const scrapeInputs: TescoProductPageInput[] = pages.map((page) => ({
    page_url: page.page_url,
    product_id: page.product_id,
  }));

  // Bright Data is called once per Tesco URL inside scrapeTescoProductPages.
  const scrapeResult = await scrapeTescoProductPages({
    pages: scrapeInputs,
    max_concurrency: maxConcurrency,
    allow_render_fallback: allowRenderFallback,
    fetch_mode: fetchMode,
    debug,
    requestTimeoutMs,
  });
  const pagesByUrl = new Map(pages.map((page) => [page.page_url, page]));
  const errorsByUrl = new Map(scrapeResult.errors.map((error) => [error.product_url, error]));
  const successfulUrls = new Set<string>();
  const successfulPageIds: string[] = [];
  const pricePayloads: Record<string, unknown>[] = [];
  const productscrappedPayloads: Record<string, unknown>[] = [];
  let itemsUpserted = 0;
  let productscrappedWritten = 0;

  for (const item of scrapeResult.items) {
    const page = pagesByUrl.get(item.product_url);
    const now = new Date().toISOString();
    const payload = {
      ...item,
      run_id: runId,
      page_index_id: page?.id ?? null,
      supermarket_code: SUPERMARKET_CODE,
      supermarket_name: SUPERMARKET_NAME,
      product_id: item.product_id ?? page?.product_id ?? null,
      product_url: item.product_url,
      last_checked_at: now,
      updated_at: now,
    };

    pricePayloads.push(payload);
    successfulUrls.add(item.product_url);
    if (page?.id) successfulPageIds.push(page.id);

    if (writeToProductscrapped) {
      productscrappedPayloads.push(productScrappedPayload(item, runId, page));
    }
  }

  if (pricePayloads.length > 0) {
    const { error } = await supabase
      .from("supermarket_item_prices")
      .upsert(pricePayloads, { onConflict: "supermarket_code,product_url" });

    if (error) {
      console.warn("[tescoPageWorker] Bulk price upsert failed; retrying per row", {
        run_id: runId,
        rows: pricePayloads.length,
        code: error.code,
        message: error.message,
      });

      successfulUrls.clear();
      successfulPageIds.length = 0;
      for (const payload of pricePayloads) {
        const productUrl = String(payload.product_url ?? "");
        const page = pagesByUrl.get(productUrl);
        const { error: rowError } = await supabase
          .from("supermarket_item_prices")
          .upsert(payload, { onConflict: "supermarket_code,product_url" });

        if (rowError) {
          await logScrapeError(supabase, {
            runId,
            pageIndexId: page?.id ?? null,
            url: productUrl,
            phase: "price_upsert",
            code: "PRICE_UPSERT_FAILED",
            message: rowError.message,
          });
          continue;
        }

        itemsUpserted++;
        successfulUrls.add(productUrl);
        if (page?.id) successfulPageIds.push(page.id);
      }
    } else {
      itemsUpserted = pricePayloads.length;
    }
  }

  const productscrappedRowsToWrite = productscrappedPayloads.filter((payload) =>
    successfulUrls.has(String(payload.product_url ?? "")),
  );

  if (writeToProductscrapped && productscrappedRowsToWrite.length > 0) {
    const { error } = await supabase.from("productscrapped").insert(productscrappedRowsToWrite);
    if (error) {
      console.warn("[tescoPageWorker] Bulk productscrapped insert failed; retrying per row", {
        run_id: runId,
        rows: productscrappedRowsToWrite.length,
        code: error.code,
        message: error.message,
      });

      for (const payload of productscrappedRowsToWrite) {
        const productUrl = String(payload.product_url ?? "");
        const page = pagesByUrl.get(productUrl);
        const { error: writeError } = await supabase.from("productscrapped").insert(payload);
        if (writeError) {
          await logScrapeError(supabase, {
            runId,
            pageIndexId: page?.id ?? null,
            url: productUrl,
            phase: "productscrapped_write",
            code: "PRODUCTSCRAPPED_WRITE_FAILED",
            message: writeError.message,
          });
        } else {
          productscrappedWritten++;
        }
      }
    } else {
      productscrappedWritten = productscrappedRowsToWrite.length;
    }
  }

  if (successfulPageIds.length > 0) {
    for (const idChunk of chunkArray(successfulPageIds, 100)) {
      const { error } = await supabase
        .from("supermarket_page_index")
        .update({
          scrape_status: "scraped",
          last_http_status: 200,
          last_scraped_at: new Date().toISOString(),
          last_error: null,
          claimed_by: null,
          updated_at: new Date().toISOString(),
        })
        .in("id", idChunk);
      if (error) {
        await logScrapeError(supabase, {
          runId,
          phase: "page_status_update",
          code: "PAGE_STATUS_BULK_UPDATE_FAILED",
          message: error.message,
          metadata: { page_ids: idChunk },
        });
        throw new Error(error.message);
      }
    }
  }

  const scraped = successfulPageIds.length;
  let failed = 0;

  for (const page of pages) {
    if (!successfulUrls.has(page.page_url)) {
      failed++;
      await markPageFailed(
        supabase,
        runId,
        page,
        errorsByUrl.get(page.page_url) ?? null,
        "Tesco worker did not return an item for this page",
      );
    }
  }

  return {
    claimed: pages.length,
    scraped,
    failed,
    itemsUpserted,
    productscrappedWritten,
    errorsReturned: scrapeResult.errors.length,
    stats: scrapeResult.stats,
    elapsedMs: Date.now() - startedAt,
  };
}

async function releaseClaimedPagesAfterBatchError(
  supabase: SupabaseClient,
  runId: string,
  pages: WorkerPage[],
  error: unknown,
) {
  const message = safeErrorMessage(error);

  await Promise.all(
    pages.map((page) =>
      markPageFailed(supabase, runId, page, null, `Railway worker batch failed: ${message}`),
    ),
  );
}

export async function assertTescoPageWorkerCanStart(input: TescoWorkerInput): Promise<void> {
  const runId = typeof input.run_id === "string" ? input.run_id.trim() : "";
  if (!runId) throw new Error("run_id is required");

  const adoptGlobalPendingPages = boolValue(input.adopt_global_pending_pages, true);
  const force = input.force === true;
  const supabase = createSupabaseServiceClient();

  const { data: run, error: runError } = await supabase
    .from("supermarket_price_scrape_runs")
    .select("id")
    .eq("id", runId)
    .single();
  if (runError || !run) throw new Error(runError?.message ?? "Run not found");

  await resetStalePages(supabase, runId, adoptGlobalPendingPages);
  const activePages = await activeClaimCount(supabase, runId, adoptGlobalPendingPages);
  if (activePages > 0 && !force) throw new WorkerAlreadyRunningError(activePages);
}

export async function runTescoPageWorker(input: TescoWorkerInput): Promise<TescoWorkerResult> {
  const runId = typeof input.run_id === "string" ? input.run_id.trim() : "";
  if (!runId) throw new Error("run_id is required");

  const batchSize = clampInt(input.batch_size, 10, 1, 50);
  // The batch size controls how many Supabase page rows are claimed per loop.
  const maxConcurrency = clampInt(input.max_concurrency, 2, 1, 5);
  // max_concurrency controls how many Bright Data requests are in flight at once.
  const maxRuntimeSeconds = clampInt(input.max_runtime_seconds, 600, 30, 1800);
  const requestTimeoutMs = requestTimeoutFromRuntime(maxRuntimeSeconds);
  const allowRenderFallback = boolValue(input.allow_render_fallback, true);
  const fetchMode = fetchModeValue(input.fetch_mode);
  const writeToProductscrapped = boolValue(input.write_to_productscrapped, false);
  const stopWhenNoPages = boolValue(input.stop_when_no_pages, true);
  const adoptGlobalPendingPages = boolValue(input.adopt_global_pending_pages, true);
  const debug = boolValue(input.debug, false);
  const force = input.force === true;
  const workerId = `tesco-railway-worker-${randomUUID()}`;
  const startedAt = new Date();
  const deadline = startedAt.getTime() + maxRuntimeSeconds * 1000;
  const supabase = createSupabaseServiceClient();

  let loops = 0;
  let pagesClaimed = 0;
  let pagesScraped = 0;
  let pagesFailed = 0;
  let itemsUpserted = 0;
  let productscrappedWritten = 0;
  let adoptedPages = 0;
  let recoveredActivePages = 0;
  let stoppedReason: TescoWorkerResult["stopped_reason"] = "max_runtime_reached";
  let lastError: string | null = null;
  let pendingRemaining = 0;
  let errorsCount = 0;
  const stats = emptyStats();

  console.log("[tescoPageWorker] Worker start", {
    run_id: runId,
    worker_id: workerId,
    batch_size: batchSize,
    max_concurrency: maxConcurrency,
    max_runtime_seconds: maxRuntimeSeconds,
    request_timeout_ms: requestTimeoutMs,
    allow_render_fallback: allowRenderFallback,
    fetch_mode: fetchMode,
    write_to_productscrapped: writeToProductscrapped,
    adopt_global_pending_pages: adoptGlobalPendingPages,
  });

  const { data: run, error: runError } = await supabase
    .from("supermarket_price_scrape_runs")
    .select("id,status,items_written_to_productscrapped")
    .eq("id", runId)
    .single();
  if (runError || !run) throw new Error(runError?.message ?? "Run not found");

  await resetStalePages(supabase, runId, adoptGlobalPendingPages);
  const activePages = await activeClaimCount(supabase, runId, adoptGlobalPendingPages);
  if (activePages > 0 && !force) throw new WorkerAlreadyRunningError(activePages);
  if (activePages > 0 && force) {
    recoveredActivePages = await resetActivePages(supabase, runId);
    console.log("[tescoPageWorker] Recovered active Tesco page claims", {
      run_id: runId,
      worker_id: workerId,
      recovered_active_pages: recoveredActivePages,
    });
  }

  await supabase
    .from("supermarket_price_scrape_runs")
    .update({
      status: "scraping",
      phase: "railway_worker",
      last_heartbeat_at: new Date().toISOString(),
      last_message:
        recoveredActivePages > 0
          ? `Railway worker recovered ${recoveredActivePages} active page claim(s) and started`
          : "Railway Tesco product page worker started",
      updated_at: new Date().toISOString(),
    })
    .eq("id", runId);

  try {
    while (Date.now() < deadline) {
      if (deadline - Date.now() < 1000) break;
      const { data: freshRun, error } = await supabase
        .from("supermarket_price_scrape_runs")
        .select("status")
        .eq("id", runId)
        .single();
      if (error) throw new Error(error.message);
      if (["cancelled", "paused"].includes(String(freshRun?.status ?? ""))) {
        stoppedReason = "cancelled";
        break;
      }

      await resetStalePages(supabase, runId, adoptGlobalPendingPages);
      let pages = await claimPages(supabase, runId, workerId, batchSize, "run");
      if (pages.length === 0 && adoptGlobalPendingPages) {
        pages = await claimPages(supabase, runId, workerId, batchSize, "global");
        adoptedPages += pages.length;
        if (pages.length > 0) {
          console.log("[tescoPageWorker] Adopted global Tesco pages into run", {
            run_id: runId,
            worker_id: workerId,
            pages_adopted: pages.length,
          });
        }
      }
      if (pages.length === 0) {
        const counts = await refreshRunCounts(supabase, runId, {
          last_message: "Railway worker found no claimable Tesco product pages",
        });
        pendingRemaining = counts.pending;
        errorsCount = counts.errors;
        stoppedReason = stopWhenNoPages ? "no_pages_remaining" : "max_runtime_reached";
        if (stopWhenNoPages) break;
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }

      loops++;
      pagesClaimed += pages.length;
      const claimCounts = await refreshRunCounts(supabase, runId, {
        last_message: `Railway worker batch ${loops}: ${pages.length} page(s) claimed`,
        last_error: null,
      });
      pendingRemaining = claimCounts.pending;
      errorsCount = claimCounts.errors;
      console.log("[tescoPageWorker] Batch claimed", {
        run_id: runId,
        worker_id: workerId,
        loop: loops,
        pages_claimed: pages.length,
        adopted_pages: adoptedPages,
      });

      let batch: Awaited<ReturnType<typeof processBatch>>;
      try {
        batch = await processBatch(
          supabase,
          runId,
          pages,
          maxConcurrency,
          allowRenderFallback,
          fetchMode,
          debug,
          writeToProductscrapped,
          requestTimeoutMs,
        );
      } catch (error) {
        await releaseClaimedPagesAfterBatchError(supabase, runId, pages, error);
        throw error;
      }
      pagesScraped += batch.scraped;
      pagesFailed += batch.failed;
      itemsUpserted += batch.itemsUpserted;
      productscrappedWritten += batch.productscrappedWritten;
      addStats(stats, batch.stats);

      const existingProductScrappedWrites = Number(run.items_written_to_productscrapped ?? 0);
      const counts = await refreshRunCounts(supabase, runId, {
        items_written_to_productscrapped:
          existingProductScrappedWrites + productscrappedWritten,
        last_message: `Railway worker batch ${loops}: ${batch.scraped} scraped, ${batch.failed} failed`,
        last_error: batch.failed > 0 ? `${batch.failed} page(s) failed in latest worker batch` : null,
      });
      pendingRemaining = counts.pending;
      errorsCount = counts.errors;
      lastError = batch.failed > 0 ? `${batch.failed} page(s) failed in latest worker batch` : null;

      console.log("[tescoPageWorker] Batch complete", {
        run_id: runId,
        worker_id: workerId,
        loop: loops,
        pages_claimed: batch.claimed,
        pages_scraped: batch.scraped,
        pages_failed: batch.failed,
        items_upserted: batch.itemsUpserted,
        productscrapped_written: batch.productscrappedWritten,
        stats: batch.stats,
        elapsed_ms: batch.elapsedMs,
      });
    }
  } catch (error) {
    stoppedReason = "error";
    lastError = safeErrorMessage(error);
    await logScrapeError(supabase, {
      runId,
      phase: "railway_worker",
      code: "TESCO_RAILWAY_WORKER_ERROR",
      message: lastError,
    });
  }

  const finalCounts = await refreshRunCounts(supabase, runId, {
    last_message:
      stoppedReason === "no_pages_remaining"
        ? "Railway worker completed: no Tesco product pages remain"
        : `Railway worker stopped: ${stoppedReason}`,
    last_error: lastError,
  });
  pendingRemaining = finalCounts.pending;
  errorsCount = finalCounts.errors;

  if (pendingRemaining === 0 && finalCounts.scraping === 0) {
    await supabase
      .from("supermarket_price_scrape_runs")
      .update({
        status: "completed",
        phase: "completed",
        finished_at: new Date().toISOString(),
        last_message:
          finalCounts.failed > 0
            ? "Railway worker completed with failed pages"
            : "Railway worker completed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", runId);
  }

  const finishedAt = new Date();
  const result: TescoWorkerResult = {
    run_id: runId,
    worker_id: workerId,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    elapsed_ms: finishedAt.getTime() - startedAt.getTime(),
    loops,
    pages_claimed: pagesClaimed,
    pages_scraped: pagesScraped,
    pages_failed: pagesFailed,
    items_upserted: itemsUpserted,
    productscrapped_written: productscrappedWritten,
    pending_remaining: pendingRemaining,
    errors_count: errorsCount,
    adopted_pages: adoptedPages,
    stats,
    stopped_reason: stoppedReason,
    message: `Railway worker stopped: ${stoppedReason}`,
  };

  console.log("[tescoPageWorker] Worker finish", result);
  return result;
}
