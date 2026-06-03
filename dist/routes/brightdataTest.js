"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.brightdataTestRouter = void 0;
const express_1 = require("express");
exports.brightdataTestRouter = (0, express_1.Router)();
exports.brightdataTestRouter.get('/test/brightdata', async (_req, res) => {
    const apiKey = process.env.BRIGHTDATA_API_KEY;
    const zone = process.env.BRIGHTDATA_ZONE || 'cetiadataservice';
    if (!apiKey) {
        return res.status(500).json({
            success: false,
            error: 'BRIGHTDATA_API_KEY is missing',
        });
    }
    const response = await fetch('https://api.brightdata.com/request', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            zone,
            url: 'https://geo.brdtest.com/welcome.txt?product=unlocker&method=api',
            format: 'raw',
        }),
    });
    const body = await response.text();
    return res.status(response.status).json({
        success: response.ok,
        status: response.status,
        zone,
        body: body.slice(0, 1000),
    });
});
