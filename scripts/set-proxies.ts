import * as dotenv from 'dotenv';

dotenv.config();

import { MongoClient } from 'mongodb';

const PROXY_CONFIG = {
  host: 'test',
  port: 5000,
  usernamePrefix: 'test',
  password: 'test',
};

async function updateProxyConfigs() {
  const mongoUri = process.env.MONGO_URL;
  const client = new MongoClient(mongoUri);

  try {
    console.log('🔗 Подключение к MongoDB...');
    await client.connect();
    const db = client.db();
    const collection = db.collection('georegions');

    console.log('📋 Получение списка регионов...');
    const regions = await collection.find({}).toArray();
    console.log(`Найдено ${regions.length} регионов`);

    let updatedCount = 0;
    for (const region of regions) {
      const updateData = {
        host: PROXY_CONFIG.host,
        port: PROXY_CONFIG.port,
        username: `${PROXY_CONFIG.usernamePrefix}${region.name.toLowerCase()}`,
        password: PROXY_CONFIG.password,
      };

      await collection.updateOne({ _id: region._id }, { $set: updateData });
      console.log(`✅ Обновлен регион: ${region.name} -> ${updateData.username}`);
      updatedCount++;
    }

    console.log(`\n🎉 Обновлено ${updatedCount} регионов`);

  } catch (error) {
    console.error('❌ Ошибка:', error);
  } finally {
    await client.close();
  }
}

updateProxyConfigs().catch(console.error);
