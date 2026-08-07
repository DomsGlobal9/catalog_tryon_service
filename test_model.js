require('dotenv').config();
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('@prisma/client');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const model = await prisma.aiModel.findUnique({
    where: { id: 'saree1' }
  });
  console.log(model);
}

main().finally(() => prisma.$disconnect());
