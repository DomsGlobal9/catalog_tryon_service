require('dotenv').config();
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('@prisma/client');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const model = await prisma.aiModel.create({
    data: {
      id: 'model1',
      name: 'Saree Model 1',
      gender: 'female',
      frontBaseUrl: 'https://gsriztjnocjwgqkaxhhz.supabase.co/storage/v1/object/public/catalog_default_models/saree/model1/frnt.png',
      backBaseUrl: 'https://gsriztjnocjwgqkaxhhz.supabase.co/storage/v1/object/public/catalog_default_models/saree/model1/back.png',
      sideBaseUrl: 'https://gsriztjnocjwgqkaxhhz.supabase.co/storage/v1/object/public/catalog_default_models/saree/model1/side.png', // side view
      sittingBaseUrl: 'https://gsriztjnocjwgqkaxhhz.supabase.co/storage/v1/object/public/catalog_default_models/saree/model1/sitting.png' // sitting view
    }
  });

  console.log(`✅ Successfully added Saree Model 1 to the database!`);
  console.log(`Model ID: ${model.id}`);
  
  // Also log it as JSON so the user can easily copy it for their frontend
  console.log("\nFrontend Reference JSON:");
  console.log(JSON.stringify(model, null, 2));
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
