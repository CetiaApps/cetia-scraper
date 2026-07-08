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
}

export async function fetchViaBrightData(
  url: string,
): Promise<BrightDataFetchResult> {
  const apiKey = getRequiredEnv("BRIGHTDATA_API_KEY");
  const zone = process.env.BRIGHTDATA_ZONE || "cetiadataservice";

  console.log("[brightdata] Request", { zone, url });

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
    }),
  });

  const body = await response.text();

  console.log("[brightdata] Response", {
    url,
    status: response.status,
    ok: response.ok,
    bodyLength: body.length,
  });

  return {
    url,
    status: response.status,
    ok: response.ok,
    contentType: response.headers.get("content-type"),
    body,
  };
}
