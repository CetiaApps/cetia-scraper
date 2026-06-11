import type { ScrapedProduct } from '../types.js';
import { absoluteTescoUrl, normaliseWhitespace, toNumber } from '../utils/normalise.js';
import { removeImageFields } from '../utils/removeImages.js';

interface TescoProductRecord {
  id?: string;
  tpnb?: string;
  tpnc?: string;
  gtin?: string;
  title?: string;
  brandName?: string;
  defaultImageUrl?: string;
  shortDescription?: string | null;
  status?: string;
  isForSale?: boolean;
  price?: {
    actual?: number;
    unitPrice?: number;
    unitOfMeasure?: string;
  };
  promotions?: Array<{
    promotionText?: string;
    offerText?: string;
    description?: string;
  }>;
}

function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is missing`);
  }

  return value;
}

function getPositiveIntegerFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export async function scrapeTesco(
  queries: string[],
  maxResultsPerQuery: number,
): Promise<ScrapedProduct[]> {
  const results: ScrapedProduct[] = [];
  const expandedQueries = expandQueries(queries);

  console.log('[tescoCrawler] Starting Bright Data Tesco scrape', {
    queryCount: expandedQueries.length,
    maxResultsPerQuery,
    querySample: expandedQueries.slice(0, 8),
  });

  for (const query of expandedQueries) {
    const html = await fetchTescoHtml(query);
    const products = extractTescoProductsFromHtml(html, query, maxResultsPerQuery);

    console.log('[tescoCrawler] Extracted Tesco products', {
      query,
      count: products.length,
    });

    results.push(...products);
  }

  console.log('[tescoCrawler] Tesco scrape finished', {
    queryCount: expandedQueries.length,
    resultCount: results.length,
  });

  return results;
}

async function fetchTescoHtml(query: string): Promise<string> {
  const apiKey = getRequiredEnv('BRIGHTDATA_API_KEY');
  const zone = process.env.BRIGHTDATA_ZONE || 'cetiadataservice';

  const url = `https://www.tesco.com/groceries/en-GB/search?query=${encodeURIComponent(query)}`;

  console.log('[tescoCrawler] Bright Data request', {
    zone,
    url,
  });

  const response = await fetch('https://api.brightdata.com/request', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      zone,
      url,
      format: 'raw',
    }),
  });

  const body = await response.text();

  console.log('[tescoCrawler] Bright Data response', {
    status: response.status,
    ok: response.ok,
    bodyLength: body.length,
  });

  if (!response.ok) {
    throw new Error(`Bright Data request failed with status ${response.status}: ${body.slice(0, 500)}`);
  }

  return body;
}

function extractTescoProductsFromHtml(
  html: string,
  query: string,
  maxResults: number,
): ScrapedProduct[] {
  const productRecords = extractProductRecords(html)
    .filter((product) => isRelevantTescoProduct(product, query));
  const limit = Math.min(productRecords.length, getPositiveIntegerFromEnv('MAX_RESULTS_PER_QUERY', maxResults));

  return productRecords.slice(0, limit).map((product, index) => {
    const priceText = typeof product.price?.actual === 'number'
      ? `£${product.price.actual.toFixed(2)}`
      : null;

    const unitPrice = typeof product.price?.unitPrice === 'number'
      ? `£${product.price.unitPrice.toFixed(2)}/${product.price.unitOfMeasure || ''}`.replace(/\/$/, '')
      : null;

    const href = product.tpnc
      ? `https://www.tesco.com/shop/en-GB/products/${product.tpnc}`
      : null;

    const promotionText =
      product.promotions?.[0]?.promotionText ||
      product.promotions?.[0]?.offerText ||
      product.promotions?.[0]?.description ||
      null;

    return {
      query,
      position: index + 1,
      supermarket_name: 'Tesco',
      supermarket_code: 'tesco',
      product_name: product.title ?? null,
      product_title: product.title ?? null,
      brand: product.brandName ?? null,
      description: product.shortDescription ?? product.title ?? null,
      price: toNumber(priceText),
      price_text: priceText,
      currency: 'GBP',
      unit_price: unitPrice,
      unit_price_value: product.price?.unitPrice ?? null,
      unit_price_unit: product.price?.unitOfMeasure ?? null,
      offer_text: promotionText,
      promotion_text: promotionText,
      availability: product.status ?? null,
      in_stock:
        typeof product.isForSale === 'boolean'
          ? product.isForSale
          : product.status
            ? /available/i.test(product.status)
            : null,
      product_url: absoluteTescoUrl(href),
      product_id: product.tpnc ?? product.id ?? null,
      sku: product.tpnb ?? null,
      gtin: product.gtin ?? null,
      barcode: product.gtin ?? null,
      category: null,
      category_path: null,
      rating: null,
      review_count: null,
      raw_data: removeImageFields({
        query,
        position: index + 1,
        product,
      }) as Record<string, unknown>,
    };
  });
}

function extractProductRecords(html: string): TescoProductRecord[] {
  const records: TescoProductRecord[] = [];
  const seen = new Set<string>();

  const regex = /"ProductType:(\d+)":\s*(\{[\s\S]*?)(?=,"[A-Za-z]+Type:|\}\}\}|\}\]\}|<\/script>)/g;

  let match: RegExpExecArray | null;

  while ((match = regex.exec(html)) !== null) {
    const productId = match[1];
    const objectStart = match.index + `"ProductType:${productId}":`.length;
    const objectText = extractBalancedJsonObject(html, objectStart);

    if (!objectText) continue;

    try {
      const product = JSON.parse(objectText) as TescoProductRecord;

      if (!product.title || seen.has(productId)) continue;

      seen.add(productId);
      records.push({
        ...product,
        id: product.id ?? productId,
      });
    } catch {
      // Ignore malformed embedded product objects.
    }
  }

  return records;
}

function isRelevantTescoProduct(product: TescoProductRecord, query: string): boolean {
  const queryNorm = normaliseText(query);
  const text = normaliseText([
    product.title,
    product.shortDescription,
    product.brandName,
  ].filter(Boolean).join(' '));
  const price = product.price?.actual;

  if (!text || typeof price !== 'number' || price <= 0) return false;

  const herb = herbTermForQuery(queryNorm);
  if (herb) {
    if (!containsTermVariant(text, herb)) return false;
    if (price > 8) return false;
    return !/\b(pesto|sauce|passata|soup|pizza|pasta|ready meal|meal kit|bourbon|whisky|whiskey|gin|vodka|rum|beer|wine|liqueur|dog|cat|pet|candle|soap|shampoo)\b/.test(text);
  }

  const plantMilk = plantMilkTermForQuery(queryNorm);
  if (plantMilk) {
    if (!containsTermVariant(text, plantMilk)) return false;
    if (!/\b(milk|drink|beverage)\b/.test(text)) return false;
    return !/\b(chocolate|praline|biscuit|cake|soap|shampoo|lotion|formula|baby)\b/.test(text);
  }

  if (isPlainMilkQuery(queryNorm)) {
    if (!containsTermVariant(text, 'milk')) return false;
    return !/\b(milk chocolate|chocolate|praline|biscuit|cake|soap|shampoo|lotion|formula|baby|condensed|evaporated|powdered)\b/.test(text);
  }

  return true;
}

function expandQueries(queries: string[]): string[] {
  const out: string[] = [];

  for (const query of queries.map((q) => q.trim()).filter(Boolean)) {
    const norm = normaliseText(query);
    const herb = herbTermForQuery(norm);
    const plantMilk = plantMilkTermForQuery(norm);

    if (herb) {
      addQuery(out, herb);
      addQuery(out, `fresh ${herb}`);
      addQuery(out, `${herb} leaves`);
      addQuery(out, `${herb} pot`);
      addQuery(out, `dried ${herb}`);
      if (norm !== `${herb}s`) addQuery(out, query);
      continue;
    }

    if (plantMilk) {
      addQuery(out, `${plantMilk} milk`);
      addQuery(out, `${plantMilk} drink`);
      addQuery(out, `${plantMilk} dairy free`);
      if (norm !== `${plantMilk} milks`) addQuery(out, query);
      continue;
    }

    addQuery(out, query);

    if (isPlainMilkQuery(norm)) {
      addQuery(out, 'milk');
      addQuery(out, 'semi skimmed milk');
      addQuery(out, 'whole milk');
    }
  }

  return out.slice(0, getPositiveIntegerFromEnv('MAX_EXPANDED_QUERIES', 7));
}

function addQuery(out: string[], query: string): void {
  const cleaned = query.trim().replace(/\s+/g, ' ');
  if (!cleaned) return;
  const key = normaliseText(cleaned);
  if (!out.some((existing) => normaliseText(existing) === key)) out.push(cleaned);
}

function herbTermForQuery(queryNorm: string): string | null {
  const herbs = ['basil', 'parsley', 'coriander', 'mint', 'thyme', 'rosemary', 'oregano', 'sage', 'dill', 'chives'];
  return herbs.find((herb) => containsTermVariant(queryNorm, herb)) ?? null;
}

function plantMilkTermForQuery(queryNorm: string): string | null {
  const terms = ['almond', 'oat', 'soya', 'soy', 'coconut', 'rice', 'cashew', 'hazelnut'];
  if (!isMilkQuery(queryNorm)) return null;
  return terms.find((term) => containsTermVariant(queryNorm, term)) ?? null;
}

function isMilkQuery(queryNorm: string): boolean {
  return containsTermVariant(queryNorm, 'milk');
}

function isPlainMilkQuery(queryNorm: string): boolean {
  return isMilkQuery(queryNorm) && !plantMilkTermForQuery(queryNorm) && !/\b(chocolate|strawberry|banana|flavoured|shake|milkshake)\b/.test(queryNorm);
}

function containsTermVariant(text: string, term: string): boolean {
  return termVariants(term).some((variant) => new RegExp(`(^| )${escapeRegex(variant)}( |$)`).test(text));
}

function termVariants(term: string): string[] {
  const variants = new Set<string>();
  const cleaned = normaliseText(term);
  if (!cleaned) return [];

  variants.add(cleaned);
  if (cleaned.endsWith('ies') && cleaned.length > 4) variants.add(`${cleaned.slice(0, -3)}y`);
  if (cleaned.endsWith('es') && cleaned.length > 4) variants.add(cleaned.slice(0, -2));
  if (cleaned.endsWith('s') && cleaned.length > 3) variants.add(cleaned.slice(0, -1));
  if (!cleaned.endsWith('s') && cleaned.length > 2) variants.add(`${cleaned}s`);

  return Array.from(variants);
}

function normaliseText(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractBalancedJsonObject(text: string, startIndex: number): string | null {
  const firstBrace = text.indexOf('{', startIndex);

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

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;

      if (depth === 0) {
        return text.slice(firstBrace, index + 1);
      }
    }
  }

  return null;
}
