# cetia-scraper

Standalone Railway scraper service for Cetia supermarket price collection.

## Stack

- Node.js
- TypeScript
- Express
- Crawlee PlaywrightCrawler
- Supabase

## Environment variables

```env
SCRAPER_API_KEY=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
MAX_CONCURRENCY=2
PORT=3000
NODE_ENV=production
CRAWLEE_STORAGE_DIR=/tmp/crawlee-storage
```

## Local development

```bash
npm install
cp .env.example .env
npm run dev
```

## Build

```bash
npm run type-check
npm run build
npm start
```

## Health check

```http
GET /health
```

## Start Tesco scrape

```http
POST /scrape/tesco
Authorization: Bearer <SCRAPER_API_KEY>
Content-Type: application/json

{
  "queries": ["milk", "bread"],
  "maxResultsPerQuery": 10
}
```

## Check job

```http
GET /jobs/:jobId
Authorization: Bearer <SCRAPER_API_KEY>
```

## Supabase table

This service writes only to `productscrapped`.

```sql
create table if not exists public.productscrapped (
    id uuid primary key default gen_random_uuid(),
    supermarket_name text not null,
    supermarket_code text not null default 'tesco',
    scrappeddate timestamptz not null default now(),
    scraper_job_id text,
    query text,
    position integer,
    product_name text,
    product_title text,
    brand text,
    description text,
    price numeric,
    price_text text,
    currency text default 'GBP',
    unit_price text,
    unit_price_value numeric,
    unit_price_unit text,
    offer_text text,
    promotion_text text,
    availability text,
    in_stock boolean,
    product_url text,
    product_id text,
    sku text,
    gtin text,
    barcode text,
    category text,
    category_path text,
    rating numeric,
    review_count integer,
    raw_data jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);
```
