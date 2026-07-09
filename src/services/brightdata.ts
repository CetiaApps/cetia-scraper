function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is missing`);
  }

  return value;
}

export interface BrightDataFetchResult {
  url: string;
  status: number;
  ok: boolean;
  contentType: string | null;
  body: string;
  render: boolean;
}

export interface BrightDataFetchOptions {
  render?: boolean;
  timeoutMs?: number;
}

export async function fetchViaBrightData(
  url: string,
  options: BrightDataFetchOptions = {},
): Promise<BrightDataFetchResult> {
  const apiKey = getRequiredEnv("BRIGHTDATA_API_KEY");
  const zone = process.env.BRIGHTDATA_ZONE || "cetiadataservice";
  const render = options.render === true;
  const timeoutMs = Math.min(
    Math.max(Number(options.timeoutMs) || 90_000, 10_000),
    180_000,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  console.log("[brightdata] Request", { zone, url, render, timeout_ms: timeoutMs });

  let response: Response;
  try {
    response = await fetch("https://api.brightdata.com/request", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        zone,
        url,
        format: "raw",
        ...(render ? { render: "true" } : {}),
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Bright Data request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const body = await response.text();

  console.log("[brightdata] Response", {
    url,
    status: response.status,
    ok: response.ok,
    render,
    bodyLength: body.length,
  });

  return {
    url,
    status: response.status,
    ok: response.ok,
    contentType: response.headers.get("content-type"),
    body,
    render,
  };
}
