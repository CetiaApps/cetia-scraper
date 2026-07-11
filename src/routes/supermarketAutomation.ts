import { Router } from "express";
import { requireApiKey } from "../index.js";
import {
  getSupermarketAdapter,
  indexSupermarketPages,
  type SupermarketCode,
} from "../services/supermarketAdapters.js";

export const supermarketAutomationRouter = Router();

supermarketAutomationRouter.post(
  "/scrape/:supermarket/sitemap-index",
  requireApiKey,
  async (req, res) => {
    const adapter = getSupermarketAdapter(req.params.supermarket);
    if (!adapter) {
      res.status(404).json({
        success: false,
        ok: false,
        error: "Unsupported supermarket",
        supermarket_code: req.params.supermarket,
      });
      return;
    }

    try {
      const result = await indexSupermarketPages(adapter.code as SupermarketCode, req.body ?? {});
      res.status(result.success ? 200 : adapter.supportsIndexing ? 502 : 400).json({
        ...result,
        ok: result.success,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        ok: false,
        supermarket_code: adapter.code,
        supermarket_name: adapter.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

supermarketAutomationRouter.post(
  "/scrape/:supermarket/run-worker",
  requireApiKey,
  async (req, res) => {
    const adapter = getSupermarketAdapter(req.params.supermarket);
    if (!adapter) {
      res.status(404).json({
        success: false,
        ok: false,
        error: "Unsupported supermarket",
        supermarket_code: req.params.supermarket,
      });
      return;
    }

    res.status(adapter.supportsPriceScraping ? 501 : 400).json({
      success: false,
      ok: false,
      supermarket_code: adapter.code,
      supermarket_name: adapter.name,
      error: adapter.supportsPriceScraping
        ? `${adapter.name} generic price scraping dispatch is not implemented on this route yet`
        : `${adapter.name} price scraping is not implemented yet`,
    });
  },
);
