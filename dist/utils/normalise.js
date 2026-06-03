"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toNumber = toNumber;
exports.normaliseWhitespace = normaliseWhitespace;
exports.absoluteTescoUrl = absoluteTescoUrl;
function toNumber(value) {
    if (value === null || value === undefined)
        return null;
    if (typeof value === 'number')
        return Number.isFinite(value) ? value : null;
    const cleaned = String(value).replace(/,/g, '').match(/[0-9]+(?:\.[0-9]+)?/);
    if (!cleaned)
        return null;
    const parsed = Number(cleaned[0]);
    return Number.isFinite(parsed) ? parsed : null;
}
function normaliseWhitespace(value) {
    if (!value)
        return null;
    const cleaned = value.replace(/\s+/g, ' ').trim();
    return cleaned.length ? cleaned : null;
}
function absoluteTescoUrl(value) {
    if (!value)
        return null;
    if (value.startsWith('http'))
        return value;
    if (value.startsWith('/'))
        return `https://www.tesco.com${value}`;
    return value;
}
