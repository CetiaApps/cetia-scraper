"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tescoBrightdataTestRouter = void 0;
const express_1 = require("express");
exports.tescoBrightdataTestRouter = (0, express_1.Router)();
exports.tescoBrightdataTestRouter.get('/test/brightdata/tesco', async (_req, res) => {
    const apiKey = process.env.BRIGHTDATA_API_KEY;
    const zone = process.env.BRIGHTDATA_ZONE || 'cetiadataservice';
    if (!apiKey) {
        return res.status(500).json({
            success: false,
            error: 'BRIGHTDATA_API_KEY is missing',
        });
    }
    const tescoUrl = 'https://www.tesco.com/groceries/en-GB/search?query=Baby%20Bottles';
    const response = await fetch('https://api.brightdata.com/request', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            zone,
            url: tescoUrl,
            format: 'raw',
        }),
    });
    const body = await response.text();
    return res.status(200).json({
        success: response.ok,
        brightDataStatus: response.status,
        tescoUrl,
        bodyLength: body.length,
        bodyPreview: body.slice(0, 2000),
        containsProductSignals: body.includes('product') ||
            body.includes('Baby Bottles') ||
            body.includes('£'),
    });
});
