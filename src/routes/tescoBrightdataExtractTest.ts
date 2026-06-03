import { Router } from 'express';

export const tescoBrightdataExtractTestRouter = Router();

function extractTescoProductsFromHtml(html: string) {
  const products: Array<{
    title: string | null;
    priceText: string | null;
  }> = [];

  const text = html;

  const titleMatches = [...text.matchAll(/"title"\s*:\s*"([^"]+)"/g)];
  const priceMatches = [...text.matchAll(/"price"\s*:\s*"?([0-9]+(?:\.[0-9]+)?)"?/g)];

  const max = Math.min(titleMatches.length, priceMatches.length, 20);

  for (let i = 0; i < max; i += 1) {
    products.push({
      title: titleMatches[i]?.[1] ?? null,
      priceText: priceMatches[i]?.[1] ? `£${priceMatches[i][1]}` : null,
    });
  }

  return products;
}

tescoBrightdataExtractTestRouter.get('/test/brightdata/tesco/extract', async (_req, res) => {
  const apiKey = process.env.BRIGHTDATA_API_KEY;
  const zone = process.env.BRIGHTDATA_ZONE || 'cetiadataservice';

  if (!apiKey) {
    return res.status(500).json({
      success: false,
      error: 'BRIGHTDATA_API_KEY is missing',
    });
  }

  const tescoUrl =
    'https://www.tesco.com/groceries/en-GB/search?query=Baby%20Bottles';

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
  const products = extractTescoProductsFromHtml(html);

  return res.status(200).json({
    success: response.ok,
    brightDataStatus: response.status,
    bodyLength: html.length,
    productCount: products.length,
    products,
  });
});
