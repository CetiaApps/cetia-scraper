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
  rawTimeoutMs?: number;
  renderTimeoutMs?: number;
  renderWaitMs?: number;
  maxRetries?: number;
  emptyHtmlRetryCount?: number;
  emptyHtmlRetryDelayMs?: number;
  retryBaseDelayMs?: number;
  waitStrategy?: string;
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
  retryNumber?: number;
  waitStrategy?: string;
  renderWaitMs?: number;
  rawTimeoutMs?: number;
  renderTimeoutMs?: number;
  rawFetchElapsedMs?: number | null;
  renderFetchElapsedMs?: number | null;
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
  return render ? 90_000 : 30_000;
}

function defaultRetries(render: boolean): number {
  return render ? 1 : 2;
}

function safeErrorMessage(value: unknown): string {
  return (value instanceof Error ? value.message : String(value)).slice(0, 1000);
}

function isEmptyResponseBody(value: string): boolean {
  return value.trim().length === 0;
}

function defaultEmptyHtmlRetries(render: boolean): number {
  return render ? 2 : 2;
}

function defaultEmptyHtmlRetryDelayMs(): number {
  return 5_000;
}

function renderExpectHeader(): string {
  return JSON.stringify({ element: 'script[type="application/ld+json"],#__NEXT_DATA__' });
}

export async function fetchTescoHtmlViaBrightData(
  url: string,
  options: BrightDataFetchOptions = {},
): Promise<BrightDataFetchResult> {
  const apiKey = getRequiredEnv("BRIGHTDATA_API_KEY");
  const zone = process.env.BRIGHTDATA_ZONE || "cetiadataservice";
  const render = options.render === true;
  const rawTimeoutMs = Math.min(
    Math.max(Number(options.rawTimeoutMs) || 30_000, 5_000),
    180_000,
  );
  const renderTimeoutMs = Math.min(
    Math.max(Number(options.renderTimeoutMs) || 90_000, 10_000),
    180_000,
  );
  const renderWaitMs = Math.min(
    Math.max(Number(options.renderWaitMs) || 10_000, 0),
    60_000,
  );
  const timeoutMs = Math.min(
    Math.max(
      Number(options.timeoutMs) ||
        (render ? renderTimeoutMs : rawTimeoutMs) ||
        defaultTimeout(render),
      5_000,
    ),
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
  const emptyHtmlRetryCount = Math.min(
    Math.max(
      Number(options.emptyHtmlRetryCount ?? defaultEmptyHtmlRetries(render)),
      0,
    ),
    5,
  );
  const emptyHtmlRetryDelayMs = Math.min(
    Math.max(
      Number(options.emptyHtmlRetryDelayMs) || defaultEmptyHtmlRetryDelayMs(),
      250,
    ),
    60_000,
  );
  const waitStrategy =
    options.waitStrategy ||
    (render
      ? "brightdata-render-x-unblock-expect-product-signals"
      : "brightdata-raw");
  const startedAt = Date.now();
  let retryableErrors = 0;
  let emptyHtmlRetries = 0;
  let lastError: string | undefined;
  let lastStatus = 0;
  let rawFetchElapsedMs: number | null = null;
  let renderFetchElapsedMs: number | null = null;
  const maxAttempts = maxRetries + emptyHtmlRetryCount + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptStartedAt = Date.now();
    console.log("[brightdata] Tesco request", {
      zone,
      url,
      render,
      attempt,
      timeout_ms: timeoutMs,
      render_wait_ms: render ? renderWaitMs : 0,
      wait_strategy: waitStrategy,
    });

    try {
      const requestBody: Record<string, unknown> = {
        zone,
        url,
        format: "raw",
        ...(render
          ? {
              render: "true",
              headers: {
                "x-unblock-expect": renderExpectHeader(),
              },
            }
          : {}),
      };

      const response = await fetch("https://api.brightdata.com/request", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(timeoutMs),
      });

      const html = await response.text();
      lastStatus = response.status;
      const fetchElapsedMs = Date.now() - attemptStartedAt;
      if (render) renderFetchElapsedMs = fetchElapsedMs;
      else rawFetchElapsedMs = fetchElapsedMs;

      console.log("[brightdata] Tesco response", {
        url,
        status: response.status,
        ok: response.ok,
        render,
        attempt,
        response_bytes: html.length,
        elapsed_ms: fetchElapsedMs,
      });

      if (response.ok && isEmptyResponseBody(html) && emptyHtmlRetries < emptyHtmlRetryCount) {
        retryableErrors++;
        emptyHtmlRetries++;
        lastError = "Bright Data returned HTTP 200 with an empty response body";
        await delay(emptyHtmlRetryDelayMs);
        continue;
      }

      const canRetryStatus =
        !response.ok &&
        RETRYABLE_STATUSES.has(response.status) &&
        retryableErrors < maxRetries;

      if (response.ok || !canRetryStatus) {
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
          retryNumber: Math.max(0, attempt - 1),
          waitStrategy,
          renderWaitMs: render ? renderWaitMs : 0,
          rawTimeoutMs,
          renderTimeoutMs,
          rawFetchElapsedMs,
          renderFetchElapsedMs,
          error: response.ok ? undefined : `Bright Data returned HTTP ${response.status}`,
        };
      }

      retryableErrors++;
      lastError = `Bright Data returned retryable HTTP ${response.status}`;
    } catch (error) {
      lastError = safeErrorMessage(error);
      if (retryableErrors >= maxRetries) break;
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
    attempt: maxAttempts,
    elapsedMs: Date.now() - startedAt,
    responseBytes: 0,
    retryableErrors,
    retryNumber: Math.max(0, maxAttempts - 1),
    waitStrategy,
    renderWaitMs: render ? renderWaitMs : 0,
    rawTimeoutMs,
    renderTimeoutMs,
    rawFetchElapsedMs,
    renderFetchElapsedMs,
    error: lastError ?? "Bright Data request failed",
  };
}

export async function fetchViaBrightData(
  url: string,
  options: BrightDataFetchOptions = {},
): Promise<BrightDataFetchResult> {
  return fetchTescoHtmlViaBrightData(url, options);
}
