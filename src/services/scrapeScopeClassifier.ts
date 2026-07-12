import { createHash } from "node:crypto";

export const SCRAPE_SCOPE_CLASSIFIER_VERSION = "scrape-scope-v1";

export type ScrapeScope = "eligible" | "excluded" | "review" | "unknown";

export type ScopeCategory =
  | "food"
  | "drink"
  | "alcohol"
  | "household_consumable"
  | "personal_care"
  | "health"
  | "baby_consumable"
  | "pet_consumable"
  | "non_grocery_homeware"
  | "clothing"
  | "electronics"
  | "books_media"
  | "toys"
  | "stationery"
  | "garden"
  | "tobacco_vaping"
  | "unknown";

export interface ScrapeScopeInput {
  supermarket_code: string;
  page_url: string;
  product_id?: string | null;
  product_name?: string | null;
  category?: string | null;
  category_path?: string | null;
  source_category_id?: string | null;
  source_category_url?: string | null;
  raw_index_data?: Record<string, unknown> | null;
}

export interface ScrapeScopeResult {
  scrape_scope: ScrapeScope;
  scope_category: ScopeCategory;
  scope_reason: string;
  scope_confidence: number;
  scope_classifier_version: string;
  scope_input_hash: string;
  scope_rule_id: string;
  scope_metadata: Record<string, unknown>;
}

type Rule = {
  id: string;
  category: ScopeCategory;
  tokens: string[];
  confidence?: number;
};

const ASDA_DUMMY_CATEGORY_SLUGS = new Set([
  "dummy-shelf-new-2",
  "dummy-shelf-new-3",
  "dummy-shelf-new-4",
  "ssr-dummy-shelf",
  "ssr-shelf",
  "new-catalog-dummy",
]);

const ELIGIBLE_RULES: Rule[] = [
  { id: "eligible-food", category: "food", tokens: ["fruit", "vegetable", "meat", "fish", "poultry", "chicken", "beef", "pork", "lamb", "bacon", "sausage", "dairy", "egg", "cheese", "yogurt", "milk", "bakery", "bread", "cake", "chilled", "frozen", "ready-meal", "food-cupboard", "pasta", "rice", "cereal", "breakfast", "snack", "crisps", "sweet", "chocolate", "biscuit", "freefrom", "free-from", "dietary", "sauce", "condiment", "soup", "beans", "tinned", "canned"] },
  { id: "eligible-drink", category: "drink", tokens: ["soft-drink", "water", "juice", "squash", "tea", "coffee", "hot-drink"] },
  { id: "eligible-alcohol", category: "alcohol", tokens: ["beer", "wine", "spirit", "cider", "lager", "vodka", "gin", "whisky", "rum", "liqueur"] },
  { id: "eligible-household", category: "household_consumable", tokens: ["toilet-roll", "toilet-paper", "kitchen-roll", "tissue", "bin-bag", "washing-up", "dishwasher", "laundry", "detergent", "fabric-conditioner", "cleaning", "bleach", "disinfectant", "air-freshener", "foil", "cling-film", "baking-paper", "sponge", "cloth", "wipes", "surface-spray"] },
  { id: "eligible-personal-care", category: "personal_care", tokens: ["soap", "shampoo", "conditioner", "shower-gel", "body-wash", "toothpaste", "mouthwash", "deodorant", "tampon", "sanitary", "period", "nappy", "nappies", "baby-wipes", "razor-blades", "shaving-foam", "skincare", "sun-cream", "sunscreen"] },
  { id: "eligible-health", category: "health", tokens: ["medicine", "healthcare", "pain-relief", "paracetamol", "ibuprofen", "vitamin", "plaster", "first-aid", "hayfever", "cold-flu"] },
  { id: "eligible-baby", category: "baby_consumable", tokens: ["baby-food", "formula", "toddler-food", "baby-milk", "baby-and-toddler"] },
  { id: "eligible-pet", category: "pet_consumable", tokens: ["dog-food", "cat-food", "pet-food", "pet-treat", "cat-litter", "pet"] },
];

const EXCLUDED_RULES: Rule[] = [
  { id: "excluded-homeware", category: "non_grocery_homeware", tokens: ["homeware", "bedding", "duvet", "towel", "furniture", "cookware", "crockery", "mug", "glassware", "kitchen-utensil", "tableware", "habitat", "ornament", "candle", "home-and-office"] },
  { id: "excluded-clothing", category: "clothing", tokens: ["clothing", "footwear", "shoe", "slipper", "sock", "t-shirt", "dress", "trouser", "underwear"] },
  { id: "excluded-electronics", category: "electronics", tokens: ["electrical", "electronics", "appliance", "mobile-phone", "phone-charger", "charger", "cable", "headphone", "battery", "light-bulb"] },
  { id: "excluded-books-media", category: "books_media", tokens: ["book", "paperback", "hardback", "dvd", "blu-ray", "cd", "magazine", "newspaper"] },
  { id: "excluded-toys", category: "toys", tokens: ["toy", "lego", "game", "puzzle", "doll"] },
  { id: "excluded-stationery", category: "stationery", tokens: ["stationery", "pen", "pencil", "notebook", "paper", "envelope", "stamp", "greeting-card", "gift-wrap"] },
  { id: "excluded-garden", category: "garden", tokens: ["garden", "outdoor-furniture", "gardening", "plant-pot", "compost", "outdoor-toy"] },
  { id: "excluded-tobacco", category: "tobacco_vaping", tokens: ["tobacco", "vape", "vaping", "e-liquid", "cigarette", "cigar"] },
];

const REVIEW_RULES: Rule[] = [
  { id: "review-cosmetics", category: "personal_care", tokens: ["lipstick", "foundation", "mascara", "nail-polish", "makeup", "cosmetic", "beauty-accessory", "false-nails"] },
  { id: "review-reusable", category: "unknown", tokens: ["reusable", "lunch-box", "food-container", "water-bottle", "storage-container"] },
  { id: "review-seasonal", category: "unknown", tokens: ["seasonal", "christmas", "easter", "halloween", "flowers", "plants"] },
  { id: "review-dummy", category: "unknown", tokens: [...ASDA_DUMMY_CATEGORY_SLUGS] },
];

function normalize(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function words(value: unknown): string {
  return normalize(value).replace(/-/g, " ");
}

function rawString(raw: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = raw?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function buildScrapeScopeInputHash(input: ScrapeScopeInput): string {
  const stable = {
    supermarket_code: normalize(input.supermarket_code),
    page_url: input.page_url,
    product_id: input.product_id ?? null,
    product_name: input.product_name ?? null,
    category: input.category ?? null,
    category_path: input.category_path ?? null,
    source_category_id: input.source_category_id ?? null,
    source_category_url: input.source_category_url ?? null,
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function asdaCategorySlug(url: string): string | null {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    const index = parts.findIndex((part) => part === "product");
    return index >= 0 ? parts[index + 1] ?? null : null;
  } catch {
    return null;
  }
}

function matchRule(haystack: string, rules: Rule[]): Rule | null {
  return rules.find((rule) => rule.tokens.some((token) => haystack.includes(normalize(token)))) ?? null;
}

function result(
  input: ScrapeScopeInput,
  scrapeScope: ScrapeScope,
  category: ScopeCategory,
  reason: string,
  confidence: number,
  ruleId: string,
  metadata: Record<string, unknown>,
): ScrapeScopeResult {
  return {
    scrape_scope: scrapeScope,
    scope_category: category,
    scope_reason: reason,
    scope_confidence: confidence,
    scope_classifier_version: SCRAPE_SCOPE_CLASSIFIER_VERSION,
    scope_input_hash: buildScrapeScopeInputHash(input),
    scope_rule_id: ruleId,
    scope_metadata: metadata,
  };
}

export function classifyScrapeScope(input: ScrapeScopeInput): ScrapeScopeResult {
  const raw = input.raw_index_data ?? {};
  const productName =
    input.product_name ??
    rawString(raw, "product_name") ??
    rawString(raw, "name") ??
    rawString(raw, "title");
  const category =
    input.category ??
    rawString(raw, "category") ??
    rawString(raw, "department") ??
    null;
  const categoryPath =
    input.category_path ??
    rawString(raw, "category_path") ??
    rawString(raw, "department_path") ??
    rawString(raw, "source_category_url") ??
    input.source_category_url ??
    null;
  const sourceCategoryUrl =
    input.source_category_url ?? rawString(raw, "source_category_url");
  const sourceCategoryId =
    input.source_category_id ?? rawString(raw, "source_category_id");
  const urlSlug = normalize(input.page_url);
  const text = [
    normalize(input.supermarket_code),
    urlSlug,
    normalize(productName),
    normalize(category),
    normalize(categoryPath),
    normalize(sourceCategoryUrl),
  ].join(" ");

  const metadata = {
    product_name: productName,
    category,
    category_path: categoryPath,
    source_category_id: sourceCategoryId,
    source_category_url: sourceCategoryUrl,
  };

  if (input.supermarket_code === "asda") {
    const slug = asdaCategorySlug(input.page_url);
    if (slug && ASDA_DUMMY_CATEGORY_SLUGS.has(normalize(slug))) {
      const nameRule = matchRule(`${normalize(productName)} ${urlSlug}`, [...ELIGIBLE_RULES, ...EXCLUDED_RULES]);
      if (!nameRule) {
        return result(input, "review", "unknown", "ASDA dummy shelf category needs review", 0.55, "asda-dummy-review", { ...metadata, asda_category_slug: slug });
      }
    }
  }

  const reviewRule = matchRule(text, REVIEW_RULES);
  if (reviewRule) {
    return result(input, "review", reviewRule.category, `Matched review rule ${reviewRule.id}`, reviewRule.confidence ?? 0.62, reviewRule.id, metadata);
  }

  const denyRule = matchRule(text, EXCLUDED_RULES);
  if (denyRule) {
    return result(input, "excluded", denyRule.category, `Matched excluded rule ${denyRule.id}`, denyRule.confidence ?? 0.9, denyRule.id, metadata);
  }

  const allowRule = matchRule(text, ELIGIBLE_RULES);
  if (allowRule) {
    return result(input, "eligible", allowRule.category, `Matched eligible rule ${allowRule.id}`, allowRule.confidence ?? 0.88, allowRule.id, metadata);
  }

  if (!productName && input.supermarket_code === "tesco") {
    return result(input, "unknown", "unknown", "Tesco URL lacks product metadata; leave for metadata backfill", 0.25, "tesco-metadata-missing", metadata);
  }

  const wordText = words(text);
  if (/\b(food|grocery|groceries|fresh|frozen|chilled|drink|household|toiletries|pet|baby)\b/.test(wordText)) {
    return result(input, "review", "unknown", "Broad grocery signal found but deterministic category is ambiguous", 0.5, "broad-signal-review", metadata);
  }

  return result(input, "unknown", "unknown", "Insufficient metadata for deterministic scrape-scope classification", 0.2, "unresolved-unknown", metadata);
}
