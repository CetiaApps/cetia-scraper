import { Router } from 'express';
import { nanoid } from 'nanoid';
import { requireApiKey } from '../index.js';
import { scrapeTesco } from '../crawlers/tescoCrawler.js';
import { createJob, markJobFailed, markJobSucceeded } from '../services/jobStore.js';
import { insertProductScrappedRows } from '../services/supabase.js';
import type { ProductScrappedRow, ScrapeRequestBody } from '../types.js';

export const scrapeRouter = Router();

function getPositiveIntegerFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

scrapeRouter.post('/scrape/tesco', requireApiKey, (req, res) => {
  const body = req.body as ScrapeRequestBody;
  const queries = body.queries ?? ['baked beans', 'whole milk', 'sourdough'];
  const maxResultsPerQuery = body.maxResultsPerQuery ?? 10;

  if (!Array.isArray(queries) || !queries.length || queries.some((query) => typeof query !== 'string' || !query.trim())) {
    res.status(400).json({ success: false, error: 'queries must be a non-empty string array' });
    return;
  }

  if (!Number.isFinite(maxResultsPerQuery) || maxResultsPerQuery < 1 || maxResultsPerQuery > 50) {
    res.status(400).json({ success: false, error: 'maxResultsPerQuery must be between 1 and 50' });
    return;
  }

  const cleanQueries = queries.map((query) => query.trim()).filter(Boolean);
  const maxTescoQueries = getPositiveIntegerFromEnv('MAX_TESCO_QUERIES', 1);
  const limitedQueries = cleanQueries.slice(0, maxTescoQueries);

  console.log('[scrape/tesco] Prepared Tesco job', {
    originalQueryCount: cleanQueries.length,
    limitedQueryCount: limitedQueries.length,
    maxTescoQueries,
    maxResultsPerQuery,
    querySample: limitedQueries.slice(0, 5),
  });

  const jobId = nanoid();
  const job = createJob(jobId, limitedQueries.length);

  void runTescoJob(jobId, limitedQueries, maxResultsPerQuery);

  res.status(202).json({
    success: true,
    jobId,
    status: job.status,
    startedAt: job.startedAt,
    queryCount: limitedQueries.length,
    originalQueryCount: cleanQueries.length,
    maxTescoQueries,
  });
});

async function runTescoJob(jobId: string, queries: string[], maxResultsPerQuery: number): Promise<void> {
  try {
    const products = await scrapeTesco(queries, maxResultsPerQuery);
    const scrappeddate = new Date().toISOString();

    const rows: ProductScrappedRow[] = products.map((product) => ({
      ...product,
      scrappeddate,
      scraper_job_id: jobId,
    }));

    const insertedCount = await insertProductScrappedRows(rows);
    markJobSucceeded(jobId, products, insertedCount);
  } catch (error) {
    markJobFailed(jobId, error);
  }
}
