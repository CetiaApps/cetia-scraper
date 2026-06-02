import type { ScrapeJob, ScrapedProduct } from '../types.js';

const jobs = new Map<string, ScrapeJob>();

export function createJob(jobId: string, queryCount: number): ScrapeJob {
  const job: ScrapeJob = {
    jobId,
    status: 'RUNNING',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    queryCount,
    itemCount: 0,
    insertedCount: 0,
    errorMessage: null,
    sampleItems: [],
  };

  jobs.set(jobId, job);
  return job;
}

export function getJob(jobId: string): ScrapeJob | undefined {
  return jobs.get(jobId);
}

export function markJobSucceeded(jobId: string, products: ScrapedProduct[], insertedCount: number): ScrapeJob {
  const job = requireJob(jobId);
  job.status = 'SUCCEEDED';
  job.finishedAt = new Date().toISOString();
  job.itemCount = products.length;
  job.insertedCount = insertedCount;
  job.sampleItems = products.slice(0, 10);
  jobs.set(jobId, job);
  return job;
}

export function markJobFailed(jobId: string, error: unknown): ScrapeJob {
  const job = requireJob(jobId);
  job.status = 'FAILED';
  job.finishedAt = new Date().toISOString();
  job.errorMessage = error instanceof Error ? error.message : String(error);
  jobs.set(jobId, job);
  return job;
}

function requireJob(jobId: string): ScrapeJob {
  const job = jobs.get(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  return job;
}
