import { Router } from "express";
import { requireApiKey } from "../index.js";
import {
  getSupermarketAdapter,
  indexSupermarketPages,
  type SupermarketCode,
} from "../services/supermarketAdapters.js";
import { createSupabaseServiceClient } from "../services/supabase.js";

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
      const body = req.body ?? {};
      const detached = body.detached === true || body.async === true;

      if (detached) {
        const runId = typeof body.run_id === "string" ? body.run_id.trim() : "";
        if (!runId) {
          res.status(400).json({
            success: false,
            ok: false,
            error: "run_id is required for detached sitemap indexing",
            supermarket_code: adapter.code,
          });
          return;
        }

        void indexSupermarketPages(adapter.code as SupermarketCode, body).catch(async (error) => {
          const message =
            error instanceof Error
              ? error.message || error.stack || error.name
              : typeof error === "string" && error.trim()
                ? error
                : JSON.stringify(error ?? "Detached indexer failed without an error payload");
          console.error("[supermarketAutomation] Detached sitemap indexer failed", {
            supermarket_code: adapter.code,
            run_id: runId,
            error: message,
          });
          try {
            const supabase = createSupabaseServiceClient();
            await supabase
              .from("supermarket_price_scrape_runs")
              .update({
                status: "failed",
                phase: "page_index_failed",
                last_message: `${adapter.name} sitemap indexer failed after dispatch`,
                last_error: message.slice(0, 1000),
                finished_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .eq("id", runId);
          } catch (updateError) {
            console.error("[supermarketAutomation] Failed to mark detached index run failed", {
              supermarket_code: adapter.code,
              run_id: runId,
              error: updateError instanceof Error ? updateError.message : String(updateError),
            });
          }
        });

        res.status(202).json({
          success: true,
          ok: true,
          supermarket_code: adapter.code,
          supermarket_name: adapter.name,
          run_id: runId,
          detached: true,
          message: `${adapter.name} sitemap indexer accepted; poll Supabase run status for source URL save totals.`,
        });
        return;
      }

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
