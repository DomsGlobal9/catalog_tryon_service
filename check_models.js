const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  try {
    const models = await prisma.aiModel.findMany({
      select: {
        id: true,
        name: true
      }
    });
    console.log(`Total models found: ${models.length}`);
    models.forEach(m => {
      console.log(`- ID: ${m.id} | Name: ${m.name}`);
    });
  } catch (error) {
    console.error("Database query failed:", error);
  } finally {
    await prisma.$disconnect();
    process.exit(0);
  }
}

main();
