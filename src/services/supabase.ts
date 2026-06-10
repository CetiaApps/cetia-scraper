import { createClient } from '@supabase/supabase-js';
import type { ProductScrappedRow } from '../types.js';

export function createSupabaseServiceClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl) throw new Error('Missing SUPABASE_URL');
  if (!serviceRoleKey) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

export async function insertProductScrappedRows(rows: ProductScrappedRow[], batchSize = 500): Promise<number> {
  if (!rows.length) return 0;

  const supabase = createSupabaseServiceClient();
  let insertedCount = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    console.log('[productscrapped] Inserting batch', {
      batchStart: i,
      batchSize: batch.length,
      supermarket: batch[0]?.supermarket_code,
      hasListItemContext: batch.some((row) => Boolean(row.list_item_id)),
      listItemIds: Array.from(new Set(batch.map((row) => row.list_item_id).filter(Boolean))).slice(0, 5),
      sample: batch.slice(0, 3).map((row) => ({
        name: row.product_name,
        price: row.price,
        query: row.query,
        list_item_id: row.list_item_id,
        supermarket_item_id: row.supermarket_item_id,
      })),
    });

    const { error } = await supabase.from('productscrapped').insert(batch);

    if (error) {
      console.error('[productscrapped] Supabase insert failed', {
        batchStart: i,
        batchSize: batch.length,
        code: error.code,
        details: error.details,
        hint: error.hint,
        message: error.message,
      });
      throw new Error(`Supabase insert failed: ${error.message}`);
    }

    insertedCount += batch.length;
    console.log('[productscrapped] Inserted batch', {
      batchStart: i,
      batchSize: batch.length,
      insertedCount,
    });
  }

  return insertedCount;
}
