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

export function removeImageFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeImageFields);

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !IMAGE_KEYS.has(key))
        .map(([key, val]) => [key, removeImageFields(val)]),
    );
  }

  return value;
}
