"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireApiKey = requireApiKey;
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const brightdataTest_js_1 = require("./routes/brightdataTest.js");
const tescoBrightdataTest_js_1 = require("./routes/tescoBrightdataTest.js");
const tescoBrightdataExtractTest_js_1 = require("./routes/tescoBrightdataExtractTest.js");
const express_1 = __importDefault(require("express"));
const health_js_1 = require("./routes/health.js");
const scrape_js_1 = require("./routes/scrape.js");
const jobs_js_1 = require("./routes/jobs.js");
function requireApiKey(req, res, next) {
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
const app = (0, express_1.default)();
app.use(express_1.default.json({ limit: '1mb' }));
app.use(brightdataTest_js_1.brightdataTestRouter);
app.use(tescoBrightdataTest_js_1.tescoBrightdataTestRouter);
app.use(tescoBrightdataExtractTest_js_1.tescoBrightdataExtractTestRouter);
app.use(health_js_1.healthRouter);
app.use(scrape_js_1.scrapeRouter);
app.use(jobs_js_1.jobsRouter);
app.use((err, _req, res, _next) => {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
});
const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
    console.log(`cetia-scraper listening on port ${port}`);
});
