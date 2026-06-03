import dotenv from 'dotenv';
dotenv.config();
import { brightdataTestRouter } from './routes/brightdataTest.js';
import { tescoBrightdataTestRouter } from './routes/tescoBrightdataTest.js';
import { tescoBrightdataExtractTestRouter } from './routes/tescoBrightdataExtractTest.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import { healthRouter } from './routes/health.js';
import { scrapeRouter } from './routes/scrape.js';
import { jobsRouter } from './routes/jobs.js';

export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.SCRAPER_API_KEY;

  if (!expected) {
    res.status(500).json({ success: false, error: 'SCRAPER_API_KEY is not configured' });
    return;
  }

  const header = req.header('authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '').trim();

  if (token !== expected) {
    res.status(401).json({ success: false, error: 'Unauthorised' });
    return;
  }

  next();
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(brightdataTestRouter);
app.use(tescoBrightdataTestRouter);
app.use(tescoBrightdataExtractTestRouter);
app.use(healthRouter);
app.use(scrapeRouter);
app.use(jobsRouter);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({ success: false, error: message });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`cetia-scraper listening on port ${port}`);
});
