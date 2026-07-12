import assert from "node:assert/strict";
import test from "node:test";
import { classifyScrapeScope } from "./scrapeScopeClassifier.js";

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

test("ASDA dummy categories are not automatically included", () => {
  const result = classifyScrapeScope({
    supermarket_code: "asda",
    page_url: "https://www.asda.com/groceries/product/dummy-shelf-new-2/example/123",
  });
  assert.equal(result.scrape_scope, "review");
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
