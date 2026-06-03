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

  console.log('[tescoCrawler] Starting Bright Data Tesco scrape', {
    queryCount: queries.length,
    maxResultsPerQuery,
    querySample: queries.slice(0, 3),
  });

  for (const query of queries) {
    const html = await fetchTescoHtml(query);
    const products = extractTescoProductsFromHtml(html, query, maxResultsPerQuery);

    console.log('[tescoCrawler] Extracted Tesco products', {
      query,
      count: products.length,
    });

    results.push(...products);
  }

  console.log('[tescoCrawler] Tesco scrape finished', {
    queryCount: queries.length,
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
  const productRecords = extractProductRecords(html);
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
