function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is missing`);
  }

  return value;
}

export type BrightDataFetchMode =
  | "raw_first"
  | "render_first"
  | "raw_only"
  | "render_only";

export interface BrightDataFetchOptions {
  render?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

export interface BrightDataFetchResult {
  html: string;
  status: number;
  render: boolean;
  attempt: number;
  elapsedMs: number;
  responseBytes: number;
  error?: string;
  url?: string;
  ok?: boolean;
  contentType?: string | null;
  body?: string;
  retryableErrors?: number;
}

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const FETCH_MODES: BrightDataFetchMode[] = [
  "raw_first",
  "render_first",
  "raw_only",
  "render_only",
];

export function getTescoProductFetchMode(): BrightDataFetchMode {
  const value = process.env.TESCO_PRODUCT_FETCH_MODE;
  return FETCH_MODES.includes(value as BrightDataFetchMode)
    ? (value as BrightDataFetchMode)
    : "raw_first";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number, baseDelayMs: number): number {
  const base = Math.min(3_000, attempt === 1 ? baseDelayMs : baseDelayMs * 3 ** (attempt - 1));
  return Math.min(3_000, base + Math.floor(Math.random() * 250));
}

function defaultTimeout(render: boolean): number {
  return render ? 60_000 : 25_000;
}

function defaultRetries(render: boolean): number {
  return render ? 1 : 2;
}

function safeErrorMessage(value: unknown): string {
  return (value instanceof Error ? value.message : String(value)).slice(0, 1000);
}

export async function fetchTescoHtmlViaBrightData(
  url: string,
  options: BrightDataFetchOptions = {},
): Promise<BrightDataFetchResult> {
  const apiKey = getRequiredEnv("BRIGHTDATA_API_KEY");
  const zone = process.env.BRIGHTDATA_ZONE || "cetiadataservice";
  const render = options.render === true;
  const timeoutMs = Math.min(
    Math.max(Number(options.timeoutMs) || defaultTimeout(render), 5_000),
    180_000,
  );
  const maxRetries = Math.min(
    Math.max(Number(options.maxRetries ?? defaultRetries(render)), 0),
    5,
  );
  const retryBaseDelayMs = Math.min(
    Math.max(Number(options.retryBaseDelayMs) || 500, 100),
    3_000,
  );
  const startedAt = Date.now();
  let retryableErrors = 0;
  let lastError: string | undefined;
  let lastStatus = 0;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    console.log("[brightdata] Tesco request", {
      zone,
      url,
      render,
      attempt,
      timeout_ms: timeoutMs,
    });

    try {
      const response = await fetch("https://api.brightdata.com/request", {
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
        signal: AbortSignal.timeout(timeoutMs),
      });

      const html = await response.text();
      lastStatus = response.status;

      console.log("[brightdata] Tesco response", {
        url,
        status: response.status,
        ok: response.ok,
        render,
        attempt,
        response_bytes: html.length,
      });

      if (response.ok || !RETRYABLE_STATUSES.has(response.status) || attempt > maxRetries) {
        return {
          url,
          html,
          body: html,
          status: response.status,
          ok: response.ok,
          contentType: response.headers.get("content-type"),
          render,
          attempt,
          elapsedMs: Date.now() - startedAt,
          responseBytes: html.length,
          retryableErrors,
          error: response.ok ? undefined : `Bright Data returned HTTP ${response.status}`,
        };
      }

      retryableErrors++;
      lastError = `Bright Data returned retryable HTTP ${response.status}`;
    } catch (error) {
      lastError = safeErrorMessage(error);
      if (attempt > maxRetries) break;
      retryableErrors++;
    }

    await delay(backoffMs(attempt, retryBaseDelayMs));
  }

  return {
    url,
    html: "",
    body: "",
    status: lastStatus,
    ok: false,
    contentType: null,
    render,
    attempt: maxRetries + 1,
    elapsedMs: Date.now() - startedAt,
    responseBytes: 0,
    retryableErrors,
    error: lastError ?? "Bright Data request failed",
  };
}

export async function fetchViaBrightData(
  url: string,
  options: BrightDataFetchOptions = {},
): Promise<BrightDataFetchResult> {
  return fetchTescoHtmlViaBrightData(url, options);
}
