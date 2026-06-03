import { PlaywrightCrawler } from 'crawlee';
import type { Page } from 'playwright'; 
import type { ScrapedProduct } from '../types.js';
import { absoluteTescoUrl, normaliseWhitespace, toNumber } from '../utils/normalise.js';
import { removeImageFields } from '../utils/removeImages.js';

interface TescoUserData {
  query: string;
  maxResultsPerQuery: number;
}

export async function scrapeTesco(queries: string[], maxResultsPerQuery: number): Promise<ScrapedProduct[]> {
  const results: ScrapedProduct[] = [];

  const startUrls = queries.map((query) => ({
    url: `https://www.tesco.com/groceries/en-GB/search?query=${encodeURIComponent(query)}`,
    userData: { query, maxResultsPerQuery } satisfies TescoUserData,
  }));

  console.log('[tescoCrawler] Starting Tesco crawl', {
    queryCount: queries.length,
    startUrlCount: startUrls.length,
    sampleUrls: startUrls.slice(0, 3).map((request) => request.url),
  });

  const crawler = new PlaywrightCrawler({
    maxConcurrency: Number(process.env.MAX_CONCURRENCY || 2),
    useSessionPool: true,
    persistCookiesPerSession: true,
    retryOnBlocked: true,
    maxRequestRetries: 3,
    requestHandlerTimeoutSecs: 120,
    navigationTimeoutSecs: 60,
    launchContext: {
      launchOptions: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
    },
    async requestHandler({ page, request, log }) {
      const { query, maxResultsPerQuery: limit } = request.userData as TescoUserData;
      log.info(`Scraping Tesco query: ${query}`);

      await handleCookieBanner(page);
      await page.waitForLoadState('networkidle').catch(() => undefined);
      await page.waitForTimeout(3000);

      const products = await extractProducts(page, query, limit);
      results.push(...products);
    },
  });

  await crawler.run(startUrls);

  console.log('[tescoCrawler] Tesco crawl finished', {
    queryCount: queries.length,
    resultCount: results.length,
  });

  return results;
}

async function handleCookieBanner(page: Page): Promise<void> {
  const buttonNames = ['Accept All', 'Accept all', 'Accept', 'Allow All', 'Allow all'];

  for (const name of buttonNames) {
    const button = page.getByRole('button', { name, exact: false }).first();
    try {
      if (await button.isVisible({ timeout: 1500 })) {
        await button.click({ timeout: 1500 });
        await page.waitForTimeout(1000);
        return;
      }
    } catch {
      // Ignore missing cookie banner/buttons.
    }
  }
}

async function extractProducts(page: Page, query: string, maxResults: number): Promise<ScrapedProduct[]> {
  const productSelectors = [
    '[data-auto="product-tile"]',
    '[data-testid="product-tile"]',
    '[data-test="product-tile"]',
    'li:has(a[href*="/products/"])',
    'div:has(a[href*="/products/"])',
  ];

  for (const selector of productSelectors) {
    const count = await page.locator(selector).count().catch(() => 0);
    if (count > 0) {
      const products: ScrapedProduct[] = [];
      const max = Math.min(count, maxResults);

      for (let index = 0; index < max; index += 1) {
        const card = page.locator(selector).nth(index);
        const text = normaliseWhitespace(await card.innerText({ timeout: 5000 }).catch(() => ''));
        const href = await card.locator('a[href*="/products/"]').first().getAttribute('href').catch(() => null);
        const title = await extractTitle(card, text);
        const priceText = extractPriceText(text);
        const unitPrice = extractUnitPrice(text);

        products.push({
          query,
          position: index + 1,
          supermarket_name: 'Tesco',
          supermarket_code: 'tesco',
          product_name: title,
          product_title: title,
          brand: null,
          description: text,
          price: toNumber(priceText),
          price_text: priceText,
          currency: 'GBP',
          unit_price: unitPrice,
          unit_price_value: toNumber(unitPrice),
          unit_price_unit: extractUnitPriceUnit(unitPrice),
          offer_text: extractOfferText(text),
          promotion_text: extractOfferText(text),
          availability: null,
          in_stock: text ? !/out of stock|unavailable/i.test(text) : null,
          product_url: absoluteTescoUrl(href),
          product_id: extractProductId(href),
          sku: null,
          gtin: null,
          barcode: null,
          category: null,
          category_path: null,
          rating: extractRating(text),
          review_count: extractReviewCount(text),
          raw_data: removeImageFields({ query, position: index + 1, title, priceText, unitPrice, href, text }) as Record<string, unknown>,
        });
      }

      if (products.length) return products;
    }
  }

  return extractFromJsonLdOrScripts(page, query, maxResults);
}

async function extractTitle(card: ReturnType<Page['locator']>, fallbackText: string | null): Promise<string | null> {
  const candidates = [
    'h3',
    'h2',
    '[data-auto="product-tile--title"]',
    '[data-testid="product-title"]',
    'a[href*="/products/"]',
  ];

  for (const selector of candidates) {
    const value = normaliseWhitespace(await card.locator(selector).first().innerText({ timeout: 1000 }).catch(() => ''));
    if (value) return value;
  }

  return fallbackText?.split('\n').map((line) => line.trim()).find(Boolean) ?? null;
}

function extractPriceText(text: string | null): string | null {
  if (!text) return null;
  const match = text.match(/£\s?\d+(?:\.\d{1,2})?|\d+p\b/i);
  return match ? match[0].replace(/\s+/g, '') : null;
}

function extractUnitPrice(text: string | null): string | null {
  if (!text) return null;
  const match = text.match(/(?:£\s?\d+(?:\.\d{1,2})?|\d+p)\s?\/?\s?(?:kg|g|l|litre|100g|100ml|each|pack)/i);
  return match ? normaliseWhitespace(match[0]) : null;
}

function extractUnitPriceUnit(unitPrice: string | null): string | null {
  if (!unitPrice) return null;
  const match = unitPrice.match(/(?:kg|g|l|litre|100g|100ml|each|pack)$/i);
  return match ? match[0] : null;
}

function extractOfferText(text: string | null): string | null {
  if (!text) return null;
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /clubcard|offer|save|buy|deal|was/i.test(line)) ?? null;
}

function extractProductId(href: string | null): string | null {
  if (!href) return null;
  const match = href.match(/products\/(\d+)/);
  return match?.[1] ?? null;
}

function extractRating(text: string | null): number | null {
  if (!text) return null;
  const match = text.match(/(\d(?:\.\d)?)\s*(?:out of|\/)?\s*5/i);
  return match ? toNumber(match[1]) : null;
}

function extractReviewCount(text: string | null): number | null {
  if (!text) return null;
  const match = text.match(/(\d+)\s*(?:reviews?|ratings?)/i);
  return match ? toNumber(match[1]) : null;
}

async function extractFromJsonLdOrScripts(page: Page, query: string, maxResults: number): Promise<ScrapedProduct[]> {
  const scriptTexts = await page.locator('script').evaluateAll((scripts) => scripts.map((script) => script.textContent || ''));
  const joined = scriptTexts.join('\n');

  const products: ScrapedProduct[] = [];
  const regex = /"title"\s*:\s*"([^"]+)"[\s\S]{0,500}?"price"\s*:\s*"?([0-9.]+)"?/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(joined)) && products.length < maxResults) {
    const title = normaliseWhitespace(match[1]);
    const priceText = match[2] ? `£${match[2]}` : null;

    products.push({
      query,
      position: products.length + 1,
      supermarket_name: 'Tesco',
      supermarket_code: 'tesco',
      product_name: title,
      product_title: title,
      brand: null,
      description: null,
      price: toNumber(priceText),
      price_text: priceText,
      currency: 'GBP',
      unit_price: null,
      unit_price_value: null,
      unit_price_unit: null,
      offer_text: null,
      promotion_text: null,
      availability: null,
      in_stock: null,
      product_url: null,
      product_id: null,
      sku: null,
      gtin: null,
      barcode: null,
      category: null,
      category_path: null,
      rating: null,
      review_count: null,
      raw_data: removeImageFields({ query, title, priceText }) as Record<string, unknown>,
    });
  }

  return products;
}
