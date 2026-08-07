require('dotenv').config();
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('@prisma/client');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  // Check if a model already exists
  const existing = await prisma.aiModel.findFirst();
  if (existing) {
    console.log(`Model already exists. ID: ${existing.id}`);
    return;
  }

  // Create a mock model
  const model = await prisma.aiModel.create({
    data: {
      name: 'Test Model 1',
      gender: 'female',
      frontBaseUrl: 'https://example.com/front.jpg',
      backBaseUrl: 'https://example.com/back.jpg',
      leftBaseUrl: 'https://example.com/sitting.jpg',
      rightBaseUrl: 'https://example.com/side.jpg'
    }
  });

  console.log(`✅ Created test AI Model. ID: ${model.id}`);
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
