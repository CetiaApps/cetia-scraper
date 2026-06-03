"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scrapeRouter = void 0;
const express_1 = require("express");
const nanoid_1 = require("nanoid");
const index_js_1 = require("../index.js");
const tescoCrawler_js_1 = require("../crawlers/tescoCrawler.js");
const jobStore_js_1 = require("../services/jobStore.js");
const supabase_js_1 = require("../services/supabase.js");
exports.scrapeRouter = (0, express_1.Router)();
function getPositiveIntegerFromEnv(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
exports.scrapeRouter.post('/scrape/tesco', index_js_1.requireApiKey, (req, res) => {
    const body = req.body;
    const queries = body.queries ?? ['baked beans', 'whole milk', 'sourdough'];
    const maxResultsPerQuery = body.maxResultsPerQuery ?? 200;
    if (!Array.isArray(queries) || !queries.length || queries.some((query) => typeof query !== 'string' || !query.trim())) {
        res.status(400).json({ success: false, error: 'queries must be a non-empty string array' });
        return;
    }
    if (!Number.isFinite(maxResultsPerQuery) || maxResultsPerQuery < 1 || maxResultsPerQuery > 200) {
        res.status(400).json({ success: false, error: 'maxResultsPerQuery must be between 1 and 200' });
        return;
    }
    const cleanQueries = queries.map((query) => query.trim()).filter(Boolean);
    const maxTescoQueries = getPositiveIntegerFromEnv('MAX_TESCO_QUERIES', 200);
    const limitedQueries = cleanQueries.slice(0, maxTescoQueries);
    console.log('[scrape/tesco] Prepared Tesco job', {
        originalQueryCount: cleanQueries.length,
        limitedQueryCount: limitedQueries.length,
        maxTescoQueries,
        maxResultsPerQuery,
        querySample: limitedQueries.slice(0, 5),
    });
    const jobId = (0, nanoid_1.nanoid)();
    const job = (0, jobStore_js_1.createJob)(jobId, limitedQueries.length);
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
async function runTescoJob(jobId, queries, maxResultsPerQuery) {
    try {
        const products = await (0, tescoCrawler_js_1.scrapeTesco)(queries, maxResultsPerQuery);
        const scrappeddate = new Date().toISOString();
        const rows = products.map((product) => ({
            ...product,
            scrappeddate,
            scraper_job_id: jobId,
        }));
        const insertedCount = await (0, supabase_js_1.insertProductScrappedRows)(rows);
        (0, jobStore_js_1.markJobSucceeded)(jobId, products, insertedCount);
    }
    catch (error) {
        (0, jobStore_js_1.markJobFailed)(jobId, error);
    }
}
