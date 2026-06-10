import { Router } from 'express';
import { nanoid } from 'nanoid';
import { requireApiKey } from '../index.js';
import { scrapeTesco } from '../crawlers/tescoCrawler.js';
import { createJob, markJobFailed, markJobSucceeded } from '../services/jobStore.js';
import { insertProductScrappedRows } from '../services/supabase.js';
import type { ProductScrappedRow, ScrapeRequestBody } from '../types.js';

export const scrapeRouter = Router();

interface ScrapeContext {
  list_item_id?: string;
  supermarket_item_id?: string;
  normalized_name?: string;
}

function getPositiveIntegerFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function cleanOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.trim();
  return cleaned.length ? cleaned : undefined;
}

function normaliseMetadataName(value: string): string {
  return value.trim().replace(/[\s-]+/g, '_').toLowerCase();
}

function buildScrapeContext(body: ScrapeRequestBody): ScrapeContext {
  const normalizedName = cleanOptionalString(body.normalized_name);

  return {
    list_item_id: cleanOptionalString(body.list_item_id),
    supermarket_item_id: cleanOptionalString(body.supermarket_item_id),
    normalized_name: normalizedName ? normaliseMetadataName(normalizedName) : undefined,
  };
}

function buildQueries(body: ScrapeRequestBody): string[] {
  const fromArray = Array.isArray(body.queries) ? body.queries : [];
  const fromSingle = [body.query, body.item_name, body.normalized_name]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

  return [...fromArray, ...fromSingle]
    .map((query) => query.trim().replace(/_/g, ' '))
    .filter(Boolean)
    .filter((query, index, arr) => arr.findIndex((other) => other.toLowerCase() === query.toLowerCase()) === index);
}

function handleTescoScrape(req: any, res: any) {
  const body = req.body as ScrapeRequestBody;
  const queries = buildQueries(body);
  const maxResultsPerQuery = body.maxResultsPerQuery ?? 200;

  if (!queries.length) {
    res.status(400).json({
      success: false,
      error: 'Provide at least one query using queries[], query, item_name, or normalized_name',
    });
    return;
  }

  if (!Number.isFinite(maxResultsPerQuery) || maxResultsPerQuery < 1 || maxResultsPerQuery > 200) {
    res.status(400).json({ success: false, error: 'maxResultsPerQuery must be between 1 and 200' });
    return;
  }

  const cleanQueries = queries.map((query) => query.trim()).filter(Boolean);
  const maxTescoQueries = getPositiveIntegerFromEnv('MAX_TESCO_QUERIES', 200);
  const limitedQueries = cleanQueries.slice(0, maxTescoQueries);
  const scrapeContext = buildScrapeContext(body);

  console.log('[scrape/tesco] Prepared Tesco job', {
    originalQueryCount: cleanQueries.length,
    limitedQueryCount: limitedQueries.length,
    maxTescoQueries,
    maxResultsPerQuery,
    querySample: limitedQueries.slice(0, 5),
    hasListItemContext: Boolean(scrapeContext.list_item_id),
    hasSupermarketItemContext: Boolean(scrapeContext.supermarket_item_id),
  });

  const jobId = nanoid();
  const job = createJob(jobId, limitedQueries.length);

  void runTescoJob(jobId, limitedQueries, maxResultsPerQuery, scrapeContext);

  res.status(202).json({
    success: true,
    jobId,
    status: job.status,
    startedAt: job.startedAt,
    queryCount: limitedQueries.length,
    originalQueryCount: cleanQueries.length,
    maxTescoQueries,
  });
}

scrapeRouter.post('/scrape/tesco', requireApiKey, handleTescoScrape);
scrapeRouter.post('/scrape', requireApiKey, handleTescoScrape);

async function runTescoJob(
  jobId: string,
  queries: string[],
  maxResultsPerQuery: number,
  scrapeContext: ScrapeContext,
): Promise<void> {
  try {
    const products = await scrapeTesco(queries, maxResultsPerQuery);
    const scrappeddate = new Date().toISOString();

    const rows: ProductScrappedRow[] = products.map((product) => ({
      ...product,
      scrappeddate,
      scraper_job_id: jobId,
      ...scrapeContext,
    }));

    console.log('[scrape/tesco] Inserting productscrapped rows', {
      jobId,
      productCount: products.length,
      rowCount: rows.length,
      hasListItemContext: Boolean(scrapeContext.list_item_id),
      listItemId: scrapeContext.list_item_id,
      supermarketItemId: scrapeContext.supermarket_item_id,
      normalizedName: scrapeContext.normalized_name,
      sample: rows.slice(0, 5).map((row) => ({
        name: row.product_name,
        price: row.price,
        query: row.query,
        list_item_id: row.list_item_id,
        supermarket_item_id: row.supermarket_item_id,
      })),
    });

    const insertedCount = await insertProductScrappedRows(rows);
    console.log('[scrape/tesco] Job completed', {
      jobId,
      productsFound: products.length,
      insertedCount,
      hasListItemContext: Boolean(scrapeContext.list_item_id),
      listItemId: scrapeContext.list_item_id,
      supermarketItemId: scrapeContext.supermarket_item_id,
      normalizedName: scrapeContext.normalized_name,
      sample: products.slice(0, 5).map((p) => ({ name: p.product_name, price: p.price })),
    });
    markJobSucceeded(jobId, products, insertedCount);
  } catch (error) {
    console.error('[scrape/tesco] Job failed', {
      jobId,
      error: error instanceof Error ? error.message : String(error),
    });
    markJobFailed(jobId, error);
  }
}
