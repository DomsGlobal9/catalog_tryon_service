require('dotenv').config();
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('@prisma/client');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {

  // Existing Saree model is already in the database.
  // DO NOT create model1 again.


  const lehengaSingleShoulder = await prisma.aiModel.create({
    data: {
      id: 'lehenga_single_shoulder',
      name: 'Lehenga - Classic Single Shoulder',
      gender: 'female',

      frontBaseUrl:
        'https://gsriztjnocjwgqkaxhhz.supabase.co/storage/v1/object/public/tryon-fits/default%20models/lehanga/lehanga1_duppat.png',

      backBaseUrl:
        'https://gsriztjnocjwgqkaxhhz.supabase.co/storage/v1/object/public/tryon-fits/default%20models/lehanga/lehanga2_duppat.png',

      sideBaseUrl:
        'https://gsriztjnocjwgqkaxhhz.supabase.co/storage/v1/object/public/tryon-fits/default%20models/lehanga/lehanga3_duppa.png',

      sittingBaseUrl:
        'https://gsriztjnocjwgqkaxhhz.supabase.co/storage/v1/object/public/tryon-fits/default%20models/lehanga/lehanga4_duppata.png'
    }
  });

  console.log('✅ Added Lehenga - Classic Single Shoulder');
  console.log(JSON.stringify(lehengaSingleShoulder, null, 2));


  const lehengaTraditional = await prisma.aiModel.create({
    data: {
      id: 'lehenga_traditional_front_pleat',
      name: 'Lehenga - Traditional Front Pleat',
      gender: 'female',

      frontBaseUrl:
        'https://gsriztjnocjwgqkaxhhz.supabase.co/storage/v1/object/public/tryon-fits/default%20models/lehanga/lehanga1_default.png',

      backBaseUrl:
        'https://gsriztjnocjwgqkaxhhz.supabase.co/storage/v1/object/public/tryon-fits/default%20models/lehanga/lehanga2_default.png',

      sideBaseUrl:
        'https://gsriztjnocjwgqkaxhhz.supabase.co/storage/v1/object/public/tryon-fits/default%20models/lehanga/lehanga3_default.png',

      sittingBaseUrl:
        'https://gsriztjnocjwgqkaxhhz.supabase.co/storage/v1/object/public/tryon-fits/default%20models/lehanga/lehanga4_default.png'
    }
  });

  console.log('✅ Added Lehenga - Traditional Front Pleat');
  console.log(JSON.stringify(lehengaTraditional, null, 2));
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });