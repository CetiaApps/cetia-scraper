import { createHash } from "node:crypto";
import {
  fetchTescoHtmlViaBrightData,
  getTescoProductFetchMode,
  type BrightDataFetchMode,
  type BrightDataFetchResult,
} from "../services/brightdata.js";
import {
  absoluteTescoUrl,
  normaliseWhitespace,
  toNumber,
} from "../utils/normalise.js";
import { removeImageFields } from "../utils/removeImages.js";
import { productIdFromTescoUrl } from "./tescoSitemapCrawler.js";

export interface TescoProductPageInput {
  page_url: string;
  product_id?: string | null;
}

export interface TescoProductPageItem {
  supermarket_name: "Tesco";
  supermarket_code: "tesco";
  product_url: string;
  product_id: string | null;
  product_name: string | null;
  product_title: string | null;
  brand: string | null;
  description: string | null;
  price: number | null;
  price_text: string | null;
  currency: string;
  unit_price: string | null;
  unit_price_value: number | null;
  unit_price_unit: string | null;
  offer_text: string | null;
  promotion_text: string | null;
  availability: string | null;
  in_stock: boolean | null;
  image_url: string | null;
  category: string | null;
  category_path: string | null;
  sku: string | null;
  gtin: string | null;
  barcode: string | null;
  raw_data: Record<string, unknown>;
  extraction_method: string;
  extraction_confidence: number;
}

export interface TescoProductPageError {
  product_url: string;
  product_id: string | null;
  http_status: number | null;
  error_code: string;
  error_message: string;
  retryable?: boolean;
  permanent?: boolean;
  page_outcome?: string;
  metadata?: Record<string, unknown>;
}

export interface TescoProductPageScrapeOptions {
  allowRenderFallback?: boolean;
  allow_render_fallback?: boolean;
  requestTimeoutMs?: number;
  fetchMode?: BrightDataFetchMode;
  fetch_mode?: BrightDataFetchMode;
  debug?: boolean;
}

export interface TescoProductPageScrapeRequest extends TescoProductPageScrapeOptions {
  pages: TescoProductPageInput[];
  max_concurrency?: number;
}

export interface TescoProductPageScrapeStats {
  raw_fetch_success: number;
  render_fetch_success: number;
  producttype_success: number;
  jsonld_success: number;
  nextdata_success: number;
  meta_fallback_success: number;
  dead_page: number;
  consent_or_block: number;
  parse_failed: number;
  empty_html: number;
  brightdata_retryable_errors: number;
}

export interface TescoProductPageScrapeResult {
  items: TescoProductPageItem[];
  errors: TescoProductPageError[];
  scraped: number;
  failed: number;
  stats: TescoProductPageScrapeStats;
}

export interface TescoDeadPageDetection {
  isDeadPage: boolean;
  markers: string[];
  reason: string | null;
  confidence: number;
}

interface TescoEmbeddedProduct {
  id?: string;
  tpnb?: string;
  tpnc?: string;
  gtin?: string;
  title?: string;
  name?: string;
  brandName?: string;
  defaultImageUrl?: string;
  shortDescription?: string | null;
  description?: string | null;
  status?: string;
  isForSale?: boolean;
  price?: {
    actual?: number | string;
    unitPrice?: number | string;
    unitOfMeasure?: string;
  };
  promotions?: Array<{
    promotionText?: string;
    offerText?: string;
    description?: string;
  }>;
}

interface JsonLdProduct {
  "@type"?: string | string[];
  name?: string;
  brand?: string | { name?: string };
  description?: string;
  image?: string | string[];
  sku?: string;
  gtin?: string;
  gtin13?: string;
  offers?:
    | {
        price?: number | string;
        priceCurrency?: string;
        availability?: string;
      }
    | Array<{
        price?: number | string;
        priceCurrency?: string;
        availability?: string;
      }>;
}

export async function scrapeTescoProductPages(
  requestOrPages: TescoProductPageScrapeRequest | TescoProductPageInput[],
  maxConcurrency?: number,
  options: TescoProductPageScrapeOptions = {},
): Promise<TescoProductPageScrapeResult> {
  const request = Array.isArray(requestOrPages)
    ? { pages: requestOrPages, max_concurrency: maxConcurrency, ...options }
    : requestOrPages;
  const pages = request.pages;
  const concurrency = Math.min(Math.max(Math.floor(request.max_concurrency ?? 2) || 2, 1), 5);
  const scrapeOptions: TescoProductPageScrapeOptions = {
    allowRenderFallback: request.allowRenderFallback ?? request.allow_render_fallback ?? true,
    requestTimeoutMs: request.requestTimeoutMs,
    fetchMode: request.fetchMode ?? request.fetch_mode ?? getTescoProductFetchMode(),
    debug: request.debug === true,
  } as TescoProductPageScrapeOptions & { allow_render_fallback?: boolean };
  const items: TescoProductPageItem[] = [];
  const errors: TescoProductPageError[] = [];
  const stats: TescoProductPageScrapeStats = {
    raw_fetch_success: 0,
    render_fetch_success: 0,
    producttype_success: 0,
    jsonld_success: 0,
    nextdata_success: 0,
    meta_fallback_success: 0,
    dead_page: 0,
    consent_or_block: 0,
    parse_failed: 0,
    empty_html: 0,
    brightdata_retryable_errors: 0,
  };
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < pages.length) {
      const page = pages[cursor++];
      try {
        const response = await fetchTescoProductPage(page, scrapeOptions);
        stats.brightdata_retryable_errors += Number(response.retryableErrors ?? 0);
        if (response.ok) {
          if (response.render) stats.render_fetch_success++;
          else stats.raw_fetch_success++;
        }

        if (!response.ok) {
          const classified = classifyTescoFailureHtml(response.html, response.status);
          if (classified?.error_code === "TESCO_PRODUCT_PAGE_DEAD") stats.dead_page++;
          if (classified?.error_code === "TESCO_PRODUCT_PAGE_CONSENT_OR_BLOCK") {
            stats.consent_or_block++;
          }
          errors.push({
            product_url: page.page_url,
            product_id: page.product_id ?? productIdFromTescoUrl(page.page_url),
            http_status: response.status,
            error_code: classified?.error_code ?? "BRIGHTDATA_PRODUCT_PAGE_FETCH_ERROR",
            error_message:
              classified?.error_message ??
              (response.error
                ? `Bright Data product page fetch failed: ${response.error}`
                : `Bright Data product page fetch failed with HTTP ${response.status}`),
            retryable: classified?.retryable ?? true,
            permanent: classified?.permanent ?? false,
            page_outcome: classified?.page_outcome ?? "network_error",
            metadata: {
              ...buildParseDebugMetadata({
                html: response.html,
                productId: page.product_id ?? productIdFromTescoUrl(page.page_url),
                contentType: response.contentType ?? null,
                httpStatus: response.status,
                render: response.render,
                fetchAttempts: [response.render ? "render" : "raw"],
                fetchElapsedMs: response.elapsedMs,
                brightdataStatus: response.status,
                debug: scrapeOptions.debug === true,
                fetchMode: scrapeOptions.fetchMode ?? scrapeOptions.fetch_mode,
              }),
              ...(classified?.metadata ?? {}),
              ...(classified
                ? {}
                : {
                    page_outcome: "network_error",
                    outcome: "recoverable_failure",
                    retryable: true,
                    terminal: false,
                    permanent: false,
                  }),
            },
          });
          continue;
        }

        if (isEmptyHtml(response.html)) {
          stats.empty_html++;
          const productId =
            page.product_id ?? productIdFromTescoUrl(page.page_url);
          errors.push({
            product_url: page.page_url,
            product_id: productId,
            http_status: response.status,
            error_code: "BRIGHTDATA_PRODUCT_PAGE_EMPTY_HTML",
            error_message:
              "Bright Data returned HTTP 200 for the Tesco product page but the response body was empty.",
            retryable: true,
            permanent: false,
            page_outcome: "brightdata_empty_html",
            metadata: buildParseDebugMetadata({
              html: response.html,
              productId,
              contentType: response.contentType ?? null,
              httpStatus: response.status,
              render: response.render,
              fetchAttempts: [response.render ? "render" : "raw"],
              fetchElapsedMs: response.elapsedMs,
              brightdataStatus: response.status,
              debug: scrapeOptions.debug === true,
              fetchMode: scrapeOptions.fetchMode ?? scrapeOptions.fetch_mode,
              pageOutcome: "brightdata_empty_html",
              outcome: "recoverable_failure",
              retryable: true,
              terminal: false,
              permanent: false,
            }),
          });
          continue;
        }

        const item = extractTescoProductPage(response.html, page);
        if (item) {
          incrementParserStats(stats, item.extraction_method);
          items.push(item);
        } else {
          const productId = page.product_id ?? productIdFromTescoUrl(page.page_url);
          const classified = classifyTescoFailureHtml(response.html, response.status);
          if (classified?.error_code === "TESCO_PRODUCT_PAGE_DEAD") stats.dead_page++;
          else if (classified?.error_code === "TESCO_PRODUCT_PAGE_CONSENT_OR_BLOCK") {
            stats.consent_or_block++;
          } else {
            stats.parse_failed++;
          }
          errors.push({
            product_url: page.page_url,
            product_id: productId,
            http_status: response.status,
            error_code: classified?.error_code ?? "TESCO_PRODUCT_PAGE_PARSE_ERROR",
            error_message:
              classified?.error_message ??
              "Tesco product page was fetched and looks live, but no product/price data could be extracted.",
            retryable: classified?.retryable ?? true,
            permanent: classified?.permanent ?? false,
            page_outcome: classified?.page_outcome ?? "parse_error",
            metadata: {
              ...buildParseDebugMetadata({
                html: response.html,
                productId,
                contentType: response.contentType ?? null,
                httpStatus: response.status,
                render: response.render,
                fetchAttempts: [response.render ? "render" : "raw"],
                fetchElapsedMs: response.elapsedMs,
                brightdataStatus: response.status,
                debug: scrapeOptions.debug === true,
                fetchMode: scrapeOptions.fetchMode ?? scrapeOptions.fetch_mode,
                pageOutcome: classified?.page_outcome ?? "parse_error",
                outcome:
                  typeof classified?.metadata?.outcome === "string"
                    ? classified.metadata.outcome
                    : "recoverable_failure",
                retryable: classified?.retryable ?? true,
                terminal: classified?.permanent ?? false,
                permanent: classified?.permanent ?? false,
              }),
              ...(classified?.metadata ?? {}),
            },
          });
        }
      } catch (error) {
        errors.push({
          product_url: page.page_url,
          product_id: page.product_id ?? productIdFromTescoUrl(page.page_url),
          http_status: null,
          error_code: "BRIGHTDATA_PRODUCT_PAGE_FETCH_EXCEPTION",
          error_message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, pages.length) }, () => worker()),
  );

  return { items, errors, scraped: items.length, failed: errors.length, stats };
}

async function fetchTescoProductPage(
  page: TescoProductPageInput,
  options: TescoProductPageScrapeOptions,
): Promise<BrightDataFetchResult> {
  const mode = options.fetchMode ?? options.fetch_mode ?? getTescoProductFetchMode();
  const allowFallback = options.allowRenderFallback ?? options.allow_render_fallback ?? true;
  const firstRender = mode === "render_first" || mode === "render_only";
  const first = await fetchTescoHtmlViaBrightData(page.page_url, {
    render: firstRender,
    timeoutMs: options.requestTimeoutMs,
  });

  const fallbackRender =
    mode === "raw_first" ? true : mode === "render_first" ? false : null;
  if (
    fallbackRender === null ||
    !allowFallback ||
    !shouldRetryWithFallbackFetch(first)
  ) {
    return first;
  }

  console.warn("[tescoProductPageCrawler] Retrying product page with fallback fetch", {
    url: page.page_url,
    status: first.status,
    bodyLength: first.html.length,
    first_render: first.render,
    fallback_render: fallbackRender,
    reason: isEmptyHtml(first.html) ? "empty_html" : "unusable_html",
  });

  const second = await fetchTescoHtmlViaBrightData(page.page_url, {
    render: fallbackRender,
    timeoutMs: options.requestTimeoutMs,
  });
  second.retryableErrors =
    Number(first.retryableErrors ?? 0) + Number(second.retryableErrors ?? 0);
  second.elapsedMs += first.elapsedMs;
  second.attempt += first.attempt;
  return second;
}

function shouldRetryWithFallbackFetch(response: BrightDataFetchResult): boolean {
  if (!response.ok) return false;
  return isEmptyHtml(response.html) || isUnusableProductPageHtml(response.html);
}

function isEmptyHtml(html: string): boolean {
  return html.trim().length === 0;
}

function isUnusableProductPageHtml(html: string): boolean {
  if (html.length < 1000) return true;
  return (
    /access denied|request blocked|forbidden|captcha|unusual traffic|temporarily unavailable/i.test(
      html,
    ) &&
    !/"ProductType:\d+"|application\/ld\+json|id=["']__NEXT_DATA__["']/i.test(
      html,
    )
  );
}

function normaliseHtmlText(html: string): string {
  return (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function detectTescoDeadProductPage(html: string): TescoDeadPageDetection {
  const text = normaliseHtmlText(html);
  const markers: string[] = [];

  if (text.includes("not down this aisle")) markers.push("not down this aisle");
  if (text.includes("looks like that page is missing")) markers.push("looks like that page is missing");
  if (text.includes("try checking the url for errors")) markers.push("try checking the url for errors");
  if (text.includes("back to home")) markers.push("back to home");

  const hasPrimary =
    text.includes("not down this aisle") ||
    text.includes("looks like that page is missing");
  const hasSupporting =
    text.includes("try checking the url for errors") ||
    text.includes("back to home");
  const isDeadPage = hasPrimary && (hasSupporting || markers.length >= 2);

  return {
    isDeadPage,
    markers,
    reason: isDeadPage
      ? "Tesco returned missing product page / Not down this aisle"
      : null,
    confidence: isDeadPage && hasSupporting ? 0.98 : isDeadPage ? 0.9 : 0,
  };
}

function classifyTescoFailureHtml(
  html: string,
  _httpStatus: number,
): {
  error_code: string;
  error_message: string;
  retryable: boolean;
  permanent: boolean;
  page_outcome: string;
  metadata: Record<string, unknown>;
} | null {
  const text = normaliseHtmlText(html);
  const deadPage = detectTescoDeadProductPage(html);
  if (deadPage.isDeadPage) {
    return {
      error_code: "TESCO_PRODUCT_PAGE_DEAD",
      error_message:
        "Tesco returned a missing product page: Not down this aisle.",
      retryable: false,
      permanent: true,
      page_outcome: "dead_product_page",
      metadata: {
        page_outcome: "dead_product_page",
        outcome: "permanent_failure",
        terminal: true,
        retryable: false,
        permanent: true,
        has_dead_page_text: true,
        dead_page_markers: deadPage.markers,
        dead_page_confidence: deadPage.confidence,
        detected_by: "tesco_missing_page_text",
      },
    };
  }

  if (
    /cookie|consent|privacy preferences|onetrust|trustarc|accept all|access denied|request blocked|forbidden|captcha|unusual traffic|temporarily unavailable|verify you are human|security check/i.test(
      text,
    )
  ) {
    return {
      error_code: "TESCO_PRODUCT_PAGE_CONSENT_OR_BLOCK",
      error_message:
        "Tesco product page fetch returned a consent, block, cookie, or bot-check page instead of product data.",
      retryable: true,
      permanent: false,
      page_outcome: "blocked_or_consent",
      metadata: {
        page_outcome: "blocked_or_consent",
        outcome: "recoverable_failure",
        terminal: false,
        retryable: true,
        permanent: false,
        detected_by: "consent_block_text",
      },
    };
  }

  return null;
}

function extractTescoProductPage(
  html: string,
  page: TescoProductPageInput,
): TescoProductPageItem | null {
  const productType = extractProductTypeRecord(
    html,
    page.product_id ?? productIdFromTescoUrl(page.page_url),
  );
  if (productType) return buildFromProductType(productType, page);

  const jsonLd = extractJsonLdProduct(html);
  if (jsonLd) return buildFromJsonLd(jsonLd, page);

  const nextProduct = extractFromNextData(html);
  if (nextProduct)
    return buildFromPlainObject(
      nextProduct,
      page,
      "brightdata-tesco-next-data",
      0.7,
    );

  return buildFromMetaFallback(html, page);
}

function buildParseDebugMetadata(input: {
  html: string;
  productId: string | null;
  contentType: string | null;
  httpStatus: number;
  render?: boolean;
  fetchAttempts?: string[];
  fetchElapsedMs?: number;
  brightdataStatus?: number;
  debug?: boolean;
  fetchMode?: BrightDataFetchMode;
  pageOutcome?: string;
  outcome?: string;
  retryable?: boolean;
  terminal?: boolean;
  permanent?: boolean;
}): Record<string, unknown> {
  const { html, productId } = input;
  const productIdPattern = productId
    ? new RegExp(productId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    : null;
  const hasJsonLd = /application\/ld\+json/i.test(html);
  const deadPage = detectTescoDeadProductPage(html);
  const metadata: Record<string, unknown> = {
    html_length: html.length,
    html_sha256: createHash("sha256").update(html).digest("hex"),
    content_type: input.contentType,
    response_status: input.httpStatus,
    render: input.render ?? false,
    fetch_attempts: input.fetchAttempts ?? ["raw"],
    fetch_elapsed_ms: input.fetchElapsedMs ?? null,
    brightdata_status: input.brightdataStatus ?? input.httpStatus,
    title_tag: titleTag(html),
    has_price_symbol: /\u00a3|&pound;|\bpound\b|\bprice\b/i.test(html),
    has_product_id: productIdPattern ? productIdPattern.test(html) : false,
    has_json_ld: hasJsonLd,
    has_application_ld_json: hasJsonLd,
    has_producttype_json: /"ProductType:\d+"/i.test(html),
    has_next_data: /id=["']__NEXT_DATA__["']/i.test(html),
    has_redux_state:
      /__PRELOADED_STATE__|__REDUX_STATE__|redux|window\.__INITIAL_STATE__/i.test(html),
    has_consent_text:
      /cookie|consent|privacy preferences|onetrust|trustarc|accept all/i.test(html),
    has_block_text:
      /access denied|request blocked|forbidden|captcha|unusual traffic|temporarily unavailable/i.test(
        html,
      ),
    has_dead_page_text: deadPage.isDeadPage,
    dead_page_markers: deadPage.markers,
    has_bot_text:
      /bot|robot|automated|verify you are human|security check|are you a human/i.test(html),
    script_count: (html.match(/<script\b/gi) ?? []).length,
    json_ld_count: (html.match(/application\/ld\+json/gi) ?? []).length,
    parser_attempts: [
      "ProductType embedded JSON",
      "JSON-LD Product schema",
      "__NEXT_DATA__ product object",
      "meta/title/price fallback",
    ],
    page_outcome: input.pageOutcome ?? "unknown_failure",
    outcome: input.outcome ?? "recoverable_failure",
    retryable: input.retryable ?? true,
    terminal: input.terminal ?? false,
    permanent: input.permanent ?? false,
    fetch_mode: input.fetchMode ?? null,
  };

  if (input.debug === true || process.env.TESCO_DEBUG_HTML_PREVIEW === "true") {
    metadata.html_preview = sanitisedHtmlPreview(html);
  }

  return metadata;
}

function incrementParserStats(
  stats: TescoProductPageScrapeStats,
  extractionMethod: string,
) {
  if (/producttype/i.test(extractionMethod)) stats.producttype_success++;
  else if (/json-ld/i.test(extractionMethod)) stats.jsonld_success++;
  else if (/next-data/i.test(extractionMethod)) stats.nextdata_success++;
  else if (/html-meta/i.test(extractionMethod)) stats.meta_fallback_success++;
}
function sanitisedHtmlPreview(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " [script removed] ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " [style removed] ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function buildFromProductType(
  product: TescoEmbeddedProduct,
  page: TescoProductPageInput,
): TescoProductPageItem {
  const actualPrice = toNumber(product.price?.actual);
  const priceText = actualPrice !== null ? `Â£${actualPrice.toFixed(2)}` : null;
  const unitPriceValue = toNumber(product.price?.unitPrice);
  const unitPrice =
    unitPriceValue !== null
      ? `Â£${unitPriceValue.toFixed(2)}/${product.price?.unitOfMeasure || ""}`.replace(
          /\/$/,
          "",
        )
      : null;
  const promotionText =
    product.promotions?.[0]?.promotionText ||
    product.promotions?.[0]?.offerText ||
    product.promotions?.[0]?.description ||
    null;
  const title = normaliseWhitespace(product.title ?? product.name ?? null);

  return {
    supermarket_name: "Tesco",
    supermarket_code: "tesco",
    product_url: page.page_url,
    product_id:
      product.tpnc ??
      product.id ??
      page.product_id ??
      productIdFromTescoUrl(page.page_url),
    product_name: title,
    product_title: title,
    brand: normaliseWhitespace(product.brandName ?? null),
    description: normaliseWhitespace(
      product.shortDescription ?? product.description ?? null,
    ),
    price: actualPrice,
    price_text: priceText,
    currency: "GBP",
    unit_price: unitPrice,
    unit_price_value: unitPriceValue,
    unit_price_unit: normaliseWhitespace(product.price?.unitOfMeasure ?? null),
    offer_text: promotionText,
    promotion_text: promotionText,
    availability: normaliseWhitespace(product.status ?? null),
    in_stock:
      typeof product.isForSale === "boolean"
        ? product.isForSale
        : product.status
          ? /available|in stock|for sale/i.test(product.status)
          : null,
    image_url: absoluteTescoUrl(product.defaultImageUrl ?? null),
    category: null,
    category_path: null,
    sku: product.tpnb ?? null,
    gtin: product.gtin ?? null,
    barcode: product.gtin ?? null,
    raw_data: removeImageFields({ product }) as Record<string, unknown>,
    extraction_method: "brightdata-tesco-producttype-json",
    extraction_confidence: actualPrice !== null && title ? 0.95 : 0.75,
  };
}

function buildFromJsonLd(
  product: JsonLdProduct,
  page: TescoProductPageInput,
): TescoProductPageItem {
  const offer = Array.isArray(product.offers)
    ? product.offers[0]
    : product.offers;
  const price = toNumber(offer?.price);
  const brand =
    typeof product.brand === "string" ? product.brand : product.brand?.name;
  const title = normaliseWhitespace(product.name ?? null);
  const image = Array.isArray(product.image) ? product.image[0] : product.image;

  return {
    supermarket_name: "Tesco",
    supermarket_code: "tesco",
    product_url: page.page_url,
    product_id: page.product_id ?? productIdFromTescoUrl(page.page_url),
    product_name: title,
    product_title: title,
    brand: normaliseWhitespace(brand ?? null),
    description: normaliseWhitespace(product.description ?? null),
    price,
    price_text: price !== null ? `Â£${price.toFixed(2)}` : null,
    currency: offer?.priceCurrency || "GBP",
    unit_price: null,
    unit_price_value: null,
    unit_price_unit: null,
    offer_text: null,
    promotion_text: null,
    availability: normaliseWhitespace(offer?.availability ?? null),
    in_stock: offer?.availability
      ? /in stock|instock/i.test(offer.availability)
      : null,
    image_url: absoluteTescoUrl(image ?? null),
    category: null,
    category_path: null,
    sku: product.sku ?? null,
    gtin: product.gtin13 ?? product.gtin ?? null,
    barcode: product.gtin13 ?? product.gtin ?? null,
    raw_data: removeImageFields({ product }) as Record<string, unknown>,
    extraction_method: "brightdata-tesco-json-ld",
    extraction_confidence: price !== null && title ? 0.85 : 0.65,
  };
}

function buildFromPlainObject(
  product: Record<string, unknown>,
  page: TescoProductPageInput,
  method: string,
  confidence: number,
): TescoProductPageItem {
  const title =
    stringFrom(product.title) ??
    stringFrom(product.name) ??
    stringFrom(product.productName);
  const brand = stringFrom(product.brandName) ?? stringFrom(product.brand);
  const price =
    toNumber(getPath(product, ["price", "actual"])) ??
    toNumber(getPath(product, ["price", "value"])) ??
    toNumber(product.price) ??
    toNumber(product.priceText);
  const priceText =
    stringFrom(product.priceText) ??
    (price !== null ? `Â£${price.toFixed(2)}` : null);
  const productId =
    stringFrom(product.tpnc) ??
    stringFrom(product.id) ??
    stringFrom(product.productId) ??
    page.product_id ??
    productIdFromTescoUrl(page.page_url);

  return {
    supermarket_name: "Tesco",
    supermarket_code: "tesco",
    product_url: page.page_url,
    product_id: productId,
    product_name: normaliseWhitespace(title),
    product_title: normaliseWhitespace(title),
    brand: normaliseWhitespace(brand),
    description: normaliseWhitespace(
      stringFrom(product.shortDescription) ?? stringFrom(product.description),
    ),
    price,
    price_text: priceText,
    currency: stringFrom(product.currency) ?? "GBP",
    unit_price: stringFrom(product.unitPrice) ?? null,
    unit_price_value: toNumber(product.unitPriceValue),
    unit_price_unit: stringFrom(product.unitPriceUnit),
    offer_text: stringFrom(product.offerText),
    promotion_text: stringFrom(product.promotionText),
    availability:
      stringFrom(product.status) ?? stringFrom(product.availability),
    in_stock: booleanFrom(product.isForSale) ?? booleanFrom(product.inStock),
    image_url: absoluteTescoUrl(
      stringFrom(product.defaultImageUrl) ?? stringFrom(product.imageUrl),
    ),
    category: stringFrom(product.category),
    category_path: stringFrom(product.categoryPath),
    sku: stringFrom(product.tpnb) ?? stringFrom(product.sku),
    gtin: stringFrom(product.gtin),
    barcode: stringFrom(product.gtin) ?? stringFrom(product.barcode),
    raw_data: removeImageFields({ product }) as Record<string, unknown>,
    extraction_method: method,
    extraction_confidence: confidence,
  };
}

function buildFromMetaFallback(
  html: string,
  page: TescoProductPageInput,
): TescoProductPageItem | null {
  const title = metaContent(html, "og:title") ?? titleTag(html);
  const priceText =
    metaContent(html, "product:price:amount") ??
    firstMatch(html, /(?:Â£|&pound;)\s*([0-9]+(?:\.[0-9]{1,2})?)/i);
  const price = toNumber(priceText);

  if (!title && price === null) return null;

  return {
    supermarket_name: "Tesco",
    supermarket_code: "tesco",
    product_url: page.page_url,
    product_id: page.product_id ?? productIdFromTescoUrl(page.page_url),
    product_name: normaliseWhitespace(title),
    product_title: normaliseWhitespace(title),
    brand: null,
    description: normaliseWhitespace(
      metaContent(html, "description") ?? metaContent(html, "og:description"),
    ),
    price,
    price_text: price !== null ? `Â£${price.toFixed(2)}` : null,
    currency: "GBP",
    unit_price: null,
    unit_price_value: null,
    unit_price_unit: null,
    offer_text: null,
    promotion_text: null,
    availability: null,
    in_stock: null,
    image_url: absoluteTescoUrl(metaContent(html, "og:image")),
    category: null,
    category_path: null,
    sku: null,
    gtin: null,
    barcode: null,
    raw_data: { title, priceText },
    extraction_method: "brightdata-tesco-html-meta",
    extraction_confidence: price !== null && title ? 0.45 : 0.25,
  };
}

function extractProductTypeRecord(
  html: string,
  requestedProductId: string | null,
): TescoEmbeddedProduct | null {
  const records: TescoEmbeddedProduct[] = [];
  const regex =
    /"ProductType:(\d+)":\s*(\{[\s\S]*?)(?=,"[A-Za-z]+Type:|\}\}\}|\}\]\}|<\/script>)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(html)) !== null) {
    const productId = match[1];
    const objectStart = match.index + `"ProductType:${productId}":`.length;
    const objectText = extractBalancedJsonObject(html, objectStart);
    if (!objectText) continue;

    try {
      const product = JSON.parse(objectText) as TescoEmbeddedProduct;
      records.push({ ...product, id: product.id ?? productId });
    } catch {
      // Ignore malformed embedded product objects.
    }
  }

  if (!records.length) return null;
  return (
    records.find(
      (record) =>
        record.tpnc === requestedProductId || record.id === requestedProductId,
    ) ?? records[0]
  );
}

function extractJsonLdProduct(html: string): JsonLdProduct | null {
  const regex =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim()) as unknown;
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      for (const candidate of candidates) {
        const product = findJsonLdProduct(candidate);
        if (product) return product;
      }
    } catch {
      // Ignore malformed JSON-LD blocks.
    }
  }

  return null;
}

function findJsonLdProduct(value: unknown): JsonLdProduct | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const type = obj["@type"];
  const types = Array.isArray(type) ? type : [type];
  if (types.some((entry) => String(entry).toLowerCase() === "product"))
    return obj as JsonLdProduct;

  for (const nested of Object.values(obj)) {
    if (Array.isArray(nested)) {
      for (const item of nested) {
        const found = findJsonLdProduct(item);
        if (found) return found;
      }
    } else if (nested && typeof nested === "object") {
      const found = findJsonLdProduct(nested);
      if (found) return found;
    }
  }

  return null;
}

function extractFromNextData(html: string): Record<string, unknown> | null {
  const match = html.match(
    /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[1]) as unknown;
    return findProductLikeObject(parsed);
  } catch {
    return null;
  }
}

function findProductLikeObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findProductLikeObject(item);
      if (found) return found;
    }
    return null;
  }

  const obj = value as Record<string, unknown>;
  const hasName =
    typeof obj.title === "string" ||
    typeof obj.name === "string" ||
    typeof obj.productName === "string";
  const hasPrice =
    obj.price !== undefined ||
    obj.priceText !== undefined ||
    getPath(obj, ["price", "actual"]) !== undefined ||
    getPath(obj, ["price", "value"]) !== undefined;
  if (hasName && hasPrice) return obj;

  for (const nested of Object.values(obj)) {
    const found = findProductLikeObject(nested);
    if (found) return found;
  }

  return null;
}

function extractBalancedJsonObject(
  text: string,
  startIndex: number,
): string | null {
  const firstBrace = text.indexOf("{", startIndex);
  if (firstBrace < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = firstBrace; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(firstBrace, index + 1);
    }
  }

  return null;
}

function getPath(value: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = value;
  for (const part of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function stringFrom(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function booleanFrom(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function metaContent(html: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`,
    "i",
  );
  return decodeHtml(re.exec(html)?.[1] ?? null);
}

function titleTag(html: string): string | null {
  return decodeHtml(
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? null,
  );
}

function firstMatch(html: string, re: RegExp): string | null {
  const match = re.exec(html);
  if (!match) return null;
  return match[0].replace(/&pound;/gi, "Â£");
}

function decodeHtml(value: string | null): string | null {
  if (!value) return null;
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&pound;/g, "Â£")
    .replace(/\s+/g, " ")
    .trim();
}
