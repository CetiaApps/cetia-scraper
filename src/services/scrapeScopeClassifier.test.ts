import assert from "node:assert/strict";
import test from "node:test";
import { SCRAPE_SCOPE_CLASSIFIER_VERSION, classifyScrapeScope } from "./scrapeScopeClassifier.js";

test("classifier version is v2", () => {
  assert.equal(SCRAPE_SCOPE_CLASSIFIER_VERSION, "scrape-scope-v2");
});

test("new indexed grocery page becomes eligible", () => {
  const result = classifyScrapeScope({
    supermarket_code: "asda",
    page_url: "https://www.asda.com/groceries/product/sharing-crisps/example/123",
    product_name: "Ready Salted Sharing Crisps",
  });
  assert.equal(result.scrape_scope, "eligible");
  assert.equal(result.scope_category, "food");
});

test("household consumable becomes eligible", () => {
  const result = classifyScrapeScope({
    supermarket_code: "tesco",
    page_url: "https://www.tesco.com/shop/en-GB/products/123",
    product_name: "Laundry Detergent Capsules",
    category: "Laundry",
  });
  assert.equal(result.scrape_scope, "eligible");
  assert.equal(result.scope_category, "household_consumable");
});

test("book page becomes excluded", () => {
  const result = classifyScrapeScope({
    supermarket_code: "asda",
    page_url: "https://www.asda.com/groceries/product/paperback-books/example/123",
    product_name: "Paperback Book",
  });
  assert.equal(result.scrape_scope, "excluded");
  assert.equal(result.scope_category, "books_media");
});

test("bedding page becomes excluded", () => {
  const result = classifyScrapeScope({
    supermarket_code: "sainsburys",
    page_url: "https://www.sainsburys.co.uk/gol-ui/product/duvet-cover-set",
    product_name: "Duvet Cover Set",
  });
  assert.equal(result.scrape_scope, "excluded");
  assert.equal(result.scope_category, "non_grocery_homeware");
});

test("toy and electronics pages become excluded", () => {
  assert.equal(classifyScrapeScope({
    supermarket_code: "asda",
    page_url: "https://www.asda.com/groceries/product/toys/lego-set/1",
    product_name: "LEGO Set",
  }).scrape_scope, "excluded");
  assert.equal(classifyScrapeScope({
    supermarket_code: "asda",
    page_url: "https://www.asda.com/groceries/product/mobile-phone-accessories/phone-charger/1",
    product_name: "Phone Charger",
  }).scope_category, "electronics");
});

test("tobacco or vaping page becomes excluded", () => {
  const result = classifyScrapeScope({
    supermarket_code: "morrisons",
    page_url: "https://groceries.morrisons.com/products/vape-liquid/1",
    product_name: "Vape Liquid",
  });
  assert.equal(result.scrape_scope, "excluded");
  assert.equal(result.scope_category, "tobacco_vaping");
});

test("ambiguous cosmetic page becomes review", () => {
  const result = classifyScrapeScope({
    supermarket_code: "tesco",
    page_url: "https://www.tesco.com/shop/en-GB/products/456",
    product_name: "Lipstick",
  });
  assert.equal(result.scrape_scope, "review");
});

test("ASDA dummy categories are not automatically included without product signal", () => {
  const result = classifyScrapeScope({
    supermarket_code: "asda",
    page_url: "https://www.asda.com/groceries/product/dummy-shelf-new-2/example/123",
  });
  assert.equal(result.scrape_scope, "unknown");
});

test("Sainsbury household consumables are eligible and homeware is excluded", () => {
  assert.equal(classifyScrapeScope({
    supermarket_code: "sainsburys",
    page_url: "https://www.sainsburys.co.uk/gol-ui/product/toilet-roll",
    product_name: "Toilet Roll",
    raw_index_data: { source_category_url: "https://www.sainsburys.co.uk/gol-ui/groceries/household/c:1020254" },
  }).scrape_scope, "eligible");
  assert.equal(classifyScrapeScope({
    supermarket_code: "sainsburys",
    page_url: "https://www.sainsburys.co.uk/gol-ui/product/habitat-mug",
    product_name: "Habitat Mug",
    raw_index_data: { source_category_url: "https://www.sainsburys.co.uk/gol-ui/groceries/homeware-and-outdoor/c:1020225" },
  }).scrape_scope, "excluded");
});

test("Tesco page without metadata is unknown", () => {
  const result = classifyScrapeScope({
    supermarket_code: "tesco",
    page_url: "https://www.tesco.com/shop/en-GB/products/310689177",
  });
  assert.equal(result.scrape_scope, "unknown");
});

test("Tesco existing metadata classifies without a page fetch", () => {
  assert.equal(classifyScrapeScope({
    supermarket_code: "tesco",
    page_url: "https://www.tesco.com/shop/en-GB/products/310689177",
    product_name: "Tesco British Semi Skimmed Milk 2.272L",
    category: "Fresh Milk",
  }).scrape_scope, "eligible");
  assert.equal(classifyScrapeScope({
    supermarket_code: "tesco",
    page_url: "https://www.tesco.com/shop/en-GB/products/123",
    product_name: "F&F Home Buttermilk Duvet Set",
    category: "F&F Home Bedding",
  }).scrape_scope, "excluded");
});

test("negative context avoids common false positives", () => {
  assert.equal(classifyScrapeScope({
    supermarket_code: "tesco",
    page_url: "https://www.tesco.com/shop/en-GB/products/1",
    product_name: "Milk Chocolate Bar",
  }).scope_category, "food");
  assert.equal(classifyScrapeScope({
    supermarket_code: "tesco",
    page_url: "https://www.tesco.com/shop/en-GB/products/2",
    product_name: "Bath Milk",
  }).scope_category, "personal_care");
  assert.equal(classifyScrapeScope({
    supermarket_code: "tesco",
    page_url: "https://www.tesco.com/shop/en-GB/products/3",
    product_name: "F&F Home Milk Jug",
  }).scrape_scope, "excluded");
});

test("pet and baby consumables beat toy and book ambiguity", () => {
  assert.equal(classifyScrapeScope({
    supermarket_code: "ocado",
    page_url: "https://www.ocado.com/products/example-1",
    product_name: "Dog Food",
  }).scope_category, "pet_consumable");
  assert.equal(classifyScrapeScope({
    supermarket_code: "ocado",
    page_url: "https://www.ocado.com/products/example-2",
    product_name: "Dog Toy",
  }).scrape_scope, "excluded");
  assert.equal(classifyScrapeScope({
    supermarket_code: "asda",
    page_url: "https://www.asda.com/groceries/product/dummy-shelf-new-2/example/123",
    product_name: "Baby Food Pouches",
  }).scope_category, "baby_consumable");
  assert.equal(classifyScrapeScope({
    supermarket_code: "asda",
    page_url: "https://www.asda.com/groceries/product/kids-books/example/123",
    product_name: "Baby Book",
  }).scrape_scope, "excluded");
});

test("retailer metadata and URL slugs classify common rows", () => {
  assert.equal(classifyScrapeScope({
    supermarket_code: "morrisons",
    page_url: "https://groceries.morrisons.com/products/morrisons-american-style-sweet-pickles-350g/123",
  }).scrape_scope, "eligible");
  assert.equal(classifyScrapeScope({
    supermarket_code: "morrisons",
    page_url: "https://groceries.morrisons.com/products/shell-windshield-protection/123",
    product_name: "Shell Windshield Protection",
  }).scrape_scope, "excluded");
  assert.equal(classifyScrapeScope({
    supermarket_code: "sainsburys",
    page_url: "https://www.sainsburys.co.uk/gol-ui/product/example",
    raw_index_data: { source_category_url: "https://www.sainsburys.co.uk/gol-ui/groceries/food-cupboard/c:102023" },
  }).scope_category, "food");
  assert.equal(classifyScrapeScope({
    supermarket_code: "waitrose",
    page_url: "https://www.waitrose.com/ecom/products/waitrose-butter/123",
  }).scrape_scope, "eligible");
});
