import { createHash } from "node:crypto";

export const SCRAPE_SCOPE_CLASSIFIER_VERSION = "scrape-scope-v2";

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
  | "seasonal_non_grocery"
  | "unknown";

export interface ScrapeScopeInput {
  supermarket_code: string;
  page_url: string;
  product_id?: string | null;
  product_name?: string | null;
  brand?: string | null;
  description?: string | null;
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
  terms: string[];
  confidence?: number;
};

type Signal = {
  source: "department" | "category_path" | "category_slug" | "metadata" | "title" | "url_slug";
  text: string;
  weight: number;
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
  {
    id: "eligible-food",
    category: "food",
    terms: [
      "fruit", "vegetable", "veg", "salad", "meat", "fish", "seafood", "poultry", "chicken", "beef", "pork", "lamb",
      "bacon", "sausage", "ham", "dairy", "egg", "eggs", "cheese", "yogurt", "yoghurt", "milk", "butter",
      "buttermilk", "cream", "bakery", "bread", "rolls", "cake", "cakes", "pastry", "chilled", "frozen",
      "ready meal", "ready-meal", "food cupboard", "food-cupboard", "pasta", "rice", "noodles", "cereal",
      "porridge", "breakfast", "snack", "snacks", "crisps", "nuts", "confectionery", "sweet", "sweets",
      "chocolate", "biscuit", "biscuits", "freefrom", "free from", "dietary", "world foods", "sauce", "sauces",
      "condiment", "ketchup", "mayonnaise", "pickle", "pickles", "soup", "beans", "tinned", "canned", "spices",
      "herbs", "flour", "sugar", "oil", "vinegar", "jam", "honey", "dessert", "ice cream",
    ],
  },
  {
    id: "eligible-drink",
    category: "drink",
    terms: ["soft drink", "soft-drink", "water", "juice", "smoothie", "squash", "cordial", "fizzy", "tea", "coffee", "hot drink", "hot-drink"],
  },
  {
    id: "eligible-alcohol",
    category: "alcohol",
    terms: ["beer", "wine", "spirit", "spirits", "cider", "lager", "vodka", "gin", "whisky", "whiskey", "rum", "liqueur", "prosecco", "champagne"],
  },
  {
    id: "eligible-household-consumable",
    category: "household_consumable",
    terms: [
      "toilet roll", "toilet-roll", "toilet paper", "toilet-paper", "kitchen roll", "kitchen-roll", "tissue", "tissues",
      "bin bag", "bin bags", "foil", "cling film", "baking paper", "washing up liquid", "washing-up liquid",
      "dishwasher tablet", "dishwasher tablets", "laundry", "detergent", "washing capsules", "washing pods",
      "fabric conditioner", "cleaning", "cleaner", "cleaning spray", "surface spray", "bleach", "disinfectant",
      "air freshener", "sponge", "cloth", "wipes", "refuse sack", "refuse sacks",
    ],
  },
  {
    id: "eligible-personal-care",
    category: "personal_care",
    terms: [
      "soap", "hand wash", "shampoo", "conditioner", "shower gel", "body wash", "bath milk", "toothpaste",
      "mouthwash", "deodorant", "tampon", "tampons", "sanitary", "period", "incontinence", "nappy", "nappies",
      "baby wipes", "razor blades", "shaving foam", "skincare", "skin care", "moisturiser", "sun cream", "sunscreen",
    ],
  },
  {
    id: "eligible-health",
    category: "health",
    terms: ["medicine", "healthcare", "pain relief", "pain-relief", "paracetamol", "ibuprofen", "vitamin", "plaster", "first aid", "hayfever", "cold and flu", "cold flu"],
  },
  {
    id: "eligible-baby-consumable",
    category: "baby_consumable",
    terms: ["baby food", "formula", "toddler food", "baby milk", "baby wipes", "nappies", "nappy pants"],
  },
  {
    id: "eligible-pet-consumable",
    category: "pet_consumable",
    terms: ["dog food", "cat food", "pet food", "pet treat", "pet treats", "cat litter", "dog treats", "cat treats"],
  },
];

const EXCLUDED_RULES: Rule[] = [
  {
    id: "excluded-homeware",
    category: "non_grocery_homeware",
    terms: [
      "homeware", "f and f home", "f&f home", "bedding", "duvet", "bed sheet", "pillow", "towel", "furniture",
      "cookware", "frying pan", "saucepan", "crockery", "mug", "milk jug", "jug", "plate", "bowl", "glassware",
      "kitchen utensil", "tableware", "habitat", "ornament", "vase", "candle", "home and office", "home office",
      "storage box", "food container", "lunch box", "water bottle", "windshield", "screenwash", "car care",
    ],
  },
  { id: "excluded-clothing", category: "clothing", terms: ["clothing", "footwear", "shoe", "shoes", "slipper", "sock", "socks", "t-shirt", "dress", "trouser", "underwear", "bra"] },
  { id: "excluded-electronics", category: "electronics", terms: ["electrical", "electronics", "appliance", "toaster", "kettle", "microwave", "mobile phone", "phone case", "phone charger", "charger", "cable", "headphone", "television", "battery", "light bulb"] },
  { id: "excluded-books-media", category: "books_media", terms: ["book", "books", "paperback", "hardback", "dvd", "blu ray", "blu-ray", "cd", "magazine", "newspaper"] },
  { id: "excluded-toys", category: "toys", terms: ["toy", "toys", "lego", "game", "board game", "puzzle", "doll", "dog toy", "baby toy"] },
  { id: "excluded-stationery", category: "stationery", terms: ["stationery", "notebook", "pen", "pencil", "paper", "envelope", "stamp", "greeting card", "gift wrap"] },
  { id: "excluded-garden", category: "garden", terms: ["garden", "outdoor furniture", "gardening", "plant pot", "compost", "garden furniture", "fitness equipment"] },
  { id: "excluded-tobacco-vaping", category: "tobacco_vaping", terms: ["tobacco", "vape", "vaping", "e-liquid", "e liquid", "cigarette", "cigarettes", "cigar"] },
  { id: "excluded-seasonal-non-grocery", category: "seasonal_non_grocery", terms: ["christmas decoration", "halloween costume", "easter decoration", "bauble", "wreath", "gift bag"] },
];

const REVIEW_RULES: Rule[] = [
  { id: "review-makeup", category: "personal_care", terms: ["lipstick", "foundation", "mascara", "nail polish", "makeup", "cosmetic", "false nails"], confidence: 0.62 },
  { id: "review-seasonal-ambiguous", category: "unknown", terms: ["seasonal", "christmas", "easter", "halloween", "flowers", "plants"], confidence: 0.55 },
];

function normalize(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/f\s*and\s*f/g, "f and f")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slugText(value: unknown): string {
  return normalize(value).replace(/\s+/g, "-");
}

function rawString(raw: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = raw?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function extractProductSlug(url: string): string | null {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    if (parts.length === 0) return null;
    const supermarketPath = parts.join(" ");
    if (/tesco\.com$/i.test(new URL(url).hostname) && parts.some((part) => /^\d{5,}$/.test(part))) {
      return null;
    }
    const productIndex = parts.findIndex((part) => part === "product" || part === "products");
    if (productIndex >= 0) {
      return parts.slice(productIndex + 1).filter((part) => !/^\d{5,}$/.test(part)).join(" ");
    }
    return supermarketPath.replace(/\b\d{5,}\b/g, " ");
  } catch {
    return null;
  }
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

export function buildScrapeScopeInputHash(input: ScrapeScopeInput): string {
  const stable = {
    supermarket_code: normalize(input.supermarket_code),
    page_url: input.page_url,
    product_id: input.product_id ?? null,
    product_name: input.product_name ?? null,
    brand: input.brand ?? null,
    description: input.description ?? null,
    category: input.category ?? null,
    category_path: input.category_path ?? null,
    source_category_id: input.source_category_id ?? null,
    source_category_url: input.source_category_url ?? null,
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function hasTerm(text: string, term: string): boolean {
  const phrase = normalize(term);
  if (!phrase) return false;
  return new RegExp(`(^|\\s)${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(text);
}

function matchRule(text: string, rules: Rule[]): { rule: Rule; terms: string[] } | null {
  for (const rule of rules) {
    const terms = rule.terms.filter((term) => hasTerm(text, term));
    if (terms.length > 0) return { rule, terms };
  }
  return null;
}

function matchEligibleRule(text: string): { rule: Rule; terms: string[] } | null {
  const priority = [
    "eligible-pet-consumable",
    "eligible-baby-consumable",
    "eligible-personal-care",
    "eligible-health",
    "eligible-household-consumable",
    "eligible-alcohol",
    "eligible-drink",
    "eligible-food",
  ];
  const matches = ELIGIBLE_RULES
    .map((rule) => ({ rule, terms: rule.terms.filter((term) => hasTerm(text, term)) }))
    .filter((match) => match.terms.length > 0);
  return matches.sort((a, b) => priority.indexOf(a.rule.id) - priority.indexOf(b.rule.id))[0] ?? null;
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
    scope_metadata: {
      ...metadata,
      rule_version: SCRAPE_SCOPE_CLASSIFIER_VERSION,
    },
  };
}

function firstDecision(input: ScrapeScopeInput, signals: Signal[], metadata: Record<string, unknown>): ScrapeScopeResult | null {
  for (const signal of signals) {
    const excluded = matchRule(signal.text, EXCLUDED_RULES);
    if (excluded) {
      return result(input, "excluded", excluded.rule.category, `Matched excluded ${signal.source} rule ${excluded.rule.id}`, excluded.rule.confidence ?? signal.weight, excluded.rule.id, {
        ...metadata,
        source: `${signal.source}_rule`,
        matched_terms: excluded.terms,
      });
    }

    const eligible = matchEligibleRule(signal.text);
    if (eligible) {
      return result(input, "eligible", eligible.rule.category, `Matched eligible ${signal.source} rule ${eligible.rule.id}`, eligible.rule.confidence ?? signal.weight, eligible.rule.id, {
        ...metadata,
        source: `${signal.source}_rule`,
        matched_terms: eligible.terms,
      });
    }
  }
  return null;
}

export function classifyScrapeScope(input: ScrapeScopeInput): ScrapeScopeResult {
  const raw = input.raw_index_data ?? {};
  const productName =
    input.product_name ??
    rawString(raw, "product_name") ??
    rawString(raw, "name") ??
    rawString(raw, "title");
  const brand = input.brand ?? rawString(raw, "brand");
  const description = input.description ?? rawString(raw, "description");
  const department = rawString(raw, "department");
  const category =
    input.category ??
    rawString(raw, "category") ??
    department ??
    null;
  const categoryPath =
    input.category_path ??
    rawString(raw, "category_path") ??
    rawString(raw, "department_path") ??
    rawString(raw, "breadcrumb") ??
    rawString(raw, "breadcrumbs") ??
    rawString(raw, "source_category_url") ??
    input.source_category_url ??
    null;
  const sourceCategoryUrl = input.source_category_url ?? rawString(raw, "source_category_url");
  const sourceCategoryId = input.source_category_id ?? rawString(raw, "source_category_id");
  const categorySlug = input.supermarket_code === "asda" ? asdaCategorySlug(input.page_url) : sourceCategoryUrl;
  const productSlug = extractProductSlug(input.page_url);

  const metadata = {
    department,
    category,
    category_path: categoryPath,
    category_slug: categorySlug,
    source_category_id: sourceCategoryId,
    source_category_url: sourceCategoryUrl,
    product_name: productName,
    brand,
    has_description: Boolean(description),
  };

  const hasMetadata = Boolean(productName || category || categoryPath || sourceCategoryUrl || description);
  if (input.supermarket_code === "tesco" && !hasMetadata) {
    return result(input, "unknown", "unknown", "Tesco URL has no reusable product metadata; leave for metadata enrichment", 0.25, "tesco-metadata-missing", metadata);
  }

  const productSignal = normalize([productName, brand, description].filter(Boolean).join(" "));
  const slugSignal = normalize(productSlug);
  const candidateSignals: Signal[] = [
    { source: "department", text: normalize(department), weight: 0.96 },
    { source: "category_path", text: normalize(categoryPath), weight: 0.94 },
    { source: "category_slug", text: normalize(categorySlug), weight: 0.92 },
    { source: "metadata", text: productSignal, weight: 0.9 },
    { source: "title", text: normalize(productName), weight: 0.86 },
    { source: "url_slug", text: slugSignal, weight: 0.78 },
  ];
  const signals = candidateSignals.filter((signal) => signal.text);

  if (input.supermarket_code === "asda") {
    const slug = asdaCategorySlug(input.page_url);
    if (slug && ASDA_DUMMY_CATEGORY_SLUGS.has(slugText(slug))) {
      const fallback = firstDecision(input, signals.filter((signal) => signal.source === "metadata" || signal.source === "title" || signal.source === "url_slug"), {
        ...metadata,
        asda_category_slug: slug,
        dummy_shelf_fallback: true,
      });
      if (fallback) return fallback;
      return result(input, "unknown", "unknown", "ASDA dummy shelf row has no product signal for deterministic classification", 0.25, "asda-dummy-unresolved", {
        ...metadata,
        asda_category_slug: slug,
      });
    }
  }

  const decision = firstDecision(input, signals, metadata);
  if (decision) return decision;

  const reviewText = signals.map((signal) => signal.text).join(" ");
  const review = matchRule(reviewText, REVIEW_RULES);
  if (review) {
    return result(input, "review", review.rule.category, `Ambiguous row matched review rule ${review.rule.id}`, review.rule.confidence ?? 0.55, review.rule.id, {
      ...metadata,
      source: "ambiguity_rule",
      matched_terms: review.terms,
    });
  }

  return result(input, "unknown", "unknown", "Insufficient metadata for deterministic scrape-scope-v2 classification", 0.2, "unresolved-unknown", metadata);
}
