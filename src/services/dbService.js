const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * Fetches the body reference image URLs from the public.body_references table.
 * Assumes the table has columns: size, image_url, gender, wear_type.
 * If the column is named 'url', it will fallback to that.
 * 
 * @returns {Promise<Object>} Mapping of sizes to image URLs, e.g., { S: "url_s", M: "url_m", ... }
 */
async function getTopBodyReferences() {
  const query = `
    SELECT * 
    FROM public.body_references 
    WHERE gender = 'men' AND wear_type = 'top';
  `;
  
  const result = await pool.query(query);
  
  const mapping = {};
  for (const row of result.rows) {
    const size = String(row.size).toUpperCase().trim();
    // Support image_url or url or image
    const imageUrl = row.image_url || row.url || row.image;
    if (size && imageUrl) {
      mapping[size] = imageUrl;
    }
  }
  
  return mapping;
}

module.exports = {
  getTopBodyReferences,
  pool,
};
