export type JobStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED';

export interface ScrapeJob {
  jobId: string;
  status: JobStatus;
  startedAt: string;
  finishedAt: string | null;
  queryCount: number;
  itemCount: number;
  insertedCount: number;
  errorMessage: string | null;
  sampleItems: ScrapedProduct[];
}

export interface ScrapeRequestBody {
  queries?: string[];
  maxResultsPerQuery?: number;
}

export interface ScrapedProduct {
  query: string;
  position: number;
  supermarket_name: 'Tesco';
  supermarket_code: 'tesco';
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
  product_url: string | null;
  product_id: string | null;
  sku: string | null;
  gtin: string | null;
  barcode: string | null;
  category: string | null;
  category_path: string | null;
  rating: number | null;
  review_count: number | null;
  raw_data: Record<string, unknown>;
}

export interface ProductScrappedRow extends ScrapedProduct {
  scrappeddate: string;
  scraper_job_id: string;
}
