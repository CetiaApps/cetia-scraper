export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;

  const cleaned = String(value).replace(/,/g, '').match(/[0-9]+(?:\.[0-9]+)?/);
  if (!cleaned) return null;

  const parsed = Number(cleaned[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normaliseWhitespace(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length ? cleaned : null;
}

export function absoluteTescoUrl(value: string | null): string | null {
  if (!value) return null;
  if (value.startsWith('http')) return value;
  if (value.startsWith('/')) return `https://www.tesco.com${value}`;
  return value;
}
