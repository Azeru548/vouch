const path = require('path');

const databasePath = path.resolve(
  process.env.DATABASE_PATH || path.join(__dirname, 'data', 'nafdac_products.db')
);
const cachePath = path.resolve(
  process.env.CACHE_DATABASE_PATH || path.join(__dirname, 'data', 'napams_cache.db')
);

module.exports = {
  databasePath,
  cachePath,
  // 3788 in this working copy so the submitted project can keep running on 3777.
  port: Number(process.env.PORT) || 3788,
  visionModel: process.env.VISION_MODEL || 'qwen/qwen3.8-27b',
};
