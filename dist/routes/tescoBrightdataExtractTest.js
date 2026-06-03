"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tescoBrightdataExtractTestRouter = void 0;
const express_1 = require("express");
exports.tescoBrightdataExtractTestRouter = (0, express_1.Router)();
exports.tescoBrightdataExtractTestRouter.get('/test/brightdata/tesco/extract', async (_req, res) => {
    const apiKey = process.env.BRIGHTDATA_API_KEY;
    const zone = process.env.BRIGHTDATA_ZONE || 'cetiadataservice';
    if (!apiKey) {
        return res.status(500).json({
            success: false,
            error: 'BRIGHTDATA_API_KEY is missing',
        });
    }
    try {
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
        const html = await response.text();
        const markers = [
            'product-tile',
            'productTitle',
            'product-title',
            'product_name',
            'productName',
            'price',
            'actualPrice',
            'unitPrice',
            'Baby Bottles',
            '__NEXT_DATA__',
            'mfe-plp',
            'apollo',
            'graphql',
        ];
        const markerResults = markers.map((marker) => {
            const index = html.indexOf(marker);
            return {
                marker,
                found: index >= 0,
                index,
                sample: index >= 0
                    ? html.slice(Math.max(0, index - 500), index + 1500)
                    : null,
            };
        });
        return res.status(200).json({
            success: response.ok,
            brightDataStatus: response.status,
            bodyLength: html.length,
            markerResults,
        });
    }
    catch (error) {
        return res.status(500).json({
            success: false,
            error: error instanceof Error
                ? error.message
                : 'Unknown error',
        });
    }
});
