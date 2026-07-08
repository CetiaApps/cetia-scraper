import { Router } from "express";
import { requireApiKey } from "../index.js";
import { indexTescoSitemap } from "../crawlers/tescoSitemapCrawler.js";
import {
  scrapeTescoProductPages,
  type TescoProductPageInput,
} from "../crawlers/tescoProductPageCrawler.js";

export const tescoSitemapRouter = Router();

tescoSitemapRouter.post(
  "/scrape/tesco/sitemap-index",
  requireApiKey,
  async (req, res) => {
    try {
      const result = await indexTescoSitemap(req.body ?? {});
      const ok = result.pages.length > 0;

      res.status(ok ? 200 : 502).json({
        success: ok,
        ok,
        pages: result.pages,
        errors: result.errors,
        sitemap_urls_processed: result.sitemap_urls_processed,
        pages_found: result.pages_found,
        pages_skipped: result.pages_skipped,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        ok: false,
        pages: [],
        errors: [
          {
            url: null,
            http_status: null,
            error_code: "TESCO_SITEMAP_INDEX_EXCEPTION",
            error_message:
              error instanceof Error ? error.message : String(error),
          },
        ],
        sitemap_urls_processed: 0,
        pages_found: 0,
      });
    }
  },
);

tescoSitemapRouter.post(
  "/scrape/tesco/product-pages",
  requireApiKey,
  async (req, res) => {
    try {
      const body = req.body ?? {};
      const pages = normalisePages(body.pages, body.urls);

      if (!pages.length) {
        res.status(400).json({
          success: false,
          ok: false,
          items: [],
          errors: [
            {
              product_url: null,
              product_id: null,
              http_status: null,
              error_code: "NO_TESCO_PRODUCT_PAGES_PROVIDED",
              error_message:
                "Provide pages[] or urls[] with at least one Tesco product URL.",
            },
          ],
          scraped: 0,
          failed: 0,
        });
        return;
      }

      const maxConcurrency = Number(body.max_concurrency) || 2;
      const result = await scrapeTescoProductPages(pages, maxConcurrency);

      res.json({
        success: result.errors.length === 0 || result.items.length > 0,
        ok: result.errors.length === 0 || result.items.length > 0,
        items: result.items,
        errors: result.errors,
        scraped: result.items.length,
        failed: result.errors.length,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        ok: false,
        items: [],
        errors: [
          {
            product_url: null,
            product_id: null,
            http_status: null,
            error_code: "TESCO_PRODUCT_PAGES_EXCEPTION",
            error_message:
              error instanceof Error ? error.message : String(error),
          },
        ],
        scraped: 0,
        failed: 1,
      });
    }
  },
);

function normalisePages(
  pagesInput: unknown,
  urlsInput: unknown,
): TescoProductPageInput[] {
  const pages: TescoProductPageInput[] = [];

  if (Array.isArray(pagesInput)) {
    for (const page of pagesInput) {
      if (!page || typeof page !== "object") continue;
      const pageUrl = (page as Record<string, unknown>).page_url;
      const productId = (page as Record<string, unknown>).product_id;
      if (typeof pageUrl !== "string" || !pageUrl.trim()) continue;
      pages.push({
        page_url: pageUrl.trim(),
        product_id: typeof productId === "string" ? productId : null,
      });
    }
  }

  if (Array.isArray(urlsInput)) {
    for (const url of urlsInput) {
      if (typeof url !== "string" || !url.trim()) continue;
      pages.push({ page_url: url.trim(), product_id: null });
    }
  }

  const seen = new Set<string>();
  return pages.filter((page) => {
    if (seen.has(page.page_url)) return false;
    seen.add(page.page_url);
    return true;
  });
}
