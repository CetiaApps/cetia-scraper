"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.jobsRouter = void 0;
const express_1 = require("express");
const index_js_1 = require("../index.js");
const jobStore_js_1 = require("../services/jobStore.js");
exports.jobsRouter = (0, express_1.Router)();
exports.jobsRouter.get('/jobs/:jobId', index_js_1.requireApiKey, (req, res) => {
    const job = (0, jobStore_js_1.getJob)(req.params.jobId);
    if (!job) {
        res.status(404).json({ success: false, error: 'Job not found' });
        return;
    }
    res.json({ success: true, ...job });
});
