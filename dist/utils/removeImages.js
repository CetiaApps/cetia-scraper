"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.removeImageFields = removeImageFields;
const IMAGE_KEYS = new Set([
    'image',
    'imageUrl',
    'image_url',
    'images',
    'thumbnail',
    'thumbnailUrl',
    'thumbnail_url',
    'photo',
    'photos',
    'picture',
    'pictures',
]);
function removeImageFields(value) {
    if (Array.isArray(value))
        return value.map(removeImageFields);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value)
            .filter(([key]) => !IMAGE_KEYS.has(key))
            .map(([key, val]) => [key, removeImageFields(val)]));
    }
    return value;
}
