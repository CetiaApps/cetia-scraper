import { Router } from "express";
import { requireApiKey } from "../index.js";
import {
  assertTescoPageWorkerCanStart,
  runTescoPageWorker,
  WorkerAlreadyRunningError,
} from "../services/tescoPageWorker.js";

export const tescoWorkerRouter = Router();

tescoWorkerRouter.post(
  "/scrape/tesco/run-worker",
  requireApiKey,
  async (req, res) => {
    try {
      const body = req.body ?? {};
      const detached = body.detached === true || body.async === true;

      if (detached) {
        const runId = typeof body.run_id === "string" ? body.run_id.trim() : "";
        if (!runId) {
          res.status(400).json({
            success: false,
            ok: false,
            error: "run_id is required",
          });
          return;
        }

        await assertTescoPageWorkerCanStart(body);

        void runTescoPageWorker(body).catch((error) => {
          console.error("[tescoWorker] Detached Tesco worker failed", {
            run_id: runId,
            error: error instanceof Error ? error.message : String(error),
          });
        });

        res.status(202).json({
          success: true,
          ok: true,
          run_id: runId,
          detached: true,
          message:
            "Railway continuous Tesco worker started; poll Supabase run status for progress.",
        });
        return;
      }

      const result = await runTescoPageWorker(body);
      res.json({
        success: true,
        ok: true,
        ...result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof WorkerAlreadyRunningError) {
        res.status(409).json({
          success: false,
          ok: false,
          error: "worker_already_active",
          active_scraping_pages: error.activePages,
          active_worker_count: error.activePages,
          max_active_workers: error.maxActiveWorkers,
          message,
        });
        return;
      }

      const status = /run_id is required/i.test(message) ? 400 : 500;
      res.status(status).json({
        success: false,
        ok: false,
        error: message,
      });
    }
  },
);
