"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSupabaseServiceClient = createSupabaseServiceClient;
exports.insertProductScrappedRows = insertProductScrappedRows;
const supabase_js_1 = require("@supabase/supabase-js");
function createSupabaseServiceClient() {
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl)
        throw new Error('Missing SUPABASE_URL');
    if (!serviceRoleKey)
        throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
    return (0, supabase_js_1.createClient)(supabaseUrl, serviceRoleKey, {
        auth: {
            persistSession: false,
            autoRefreshToken: false,
        },
    });
}
async function insertProductScrappedRows(rows, batchSize = 500) {
    if (!rows.length)
        return 0;
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
