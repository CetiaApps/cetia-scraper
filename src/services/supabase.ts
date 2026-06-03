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
if (serviceRoleKey) {
  const payload = JSON.parse(
    Buffer.from(serviceRoleKey.split('.')[1], 'base64url').toString('utf8')
  );

  console.log('[supabase] key role:', payload.role);
  console.log('[supabase] project url:', supabaseUrl);
}
}

export async function insertProductScrappedRows(rows: ProductScrappedRow[], batchSize = 500): Promise<number> {
  if (!rows.length) return 0;

  const supabase = createSupabaseServiceClient();
  let insertedCount = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await supabase.from('productscrapped').insert(batch);

    if (error) {
      throw new Error(`Supabase insert failed: ${error.message}`);
    }

    insertedCount += batch.length;
  }

  return insertedCount;
}
