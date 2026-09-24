const path = require('path');

const databasePath = path.resolve(
  process.env.DATABASE_PATH || path.join(__dirname, 'data', 'nafdac_products.db')
);

module.exports = {
  databasePath,
  port: Number(process.env.PORT) || 3777,
  visionModel: process.env.VISION_MODEL || 'qwen/qwen3.8-27b',
};
