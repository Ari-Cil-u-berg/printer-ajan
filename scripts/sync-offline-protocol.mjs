#!/usr/bin/env node
/**
 * Çevrimdışı protokolü backend deposundan kopyalar.
 *   node scripts/sync-offline-protocol.mjs ../ari-adisyon-backend
 * Kaynak tek: backend `packages/types/src/offline*.ts`. Kopyadan sonra
 * `npm test` — vektör testi iki tarafın aynı baytları ürettiğini doğrular.
 */
import fs from 'node:fs';
import path from 'node:path';

const backend = process.argv[2];
if (!backend) {
  console.error('Kullanım: node scripts/sync-offline-protocol.mjs <backend deposu>');
  process.exit(1);
}
const src = path.join(backend, 'packages/types/src');
const dst = path.join(path.dirname(new URL(import.meta.url).pathname), '../src/main/offline');
const head = (file) =>
  `/**\n * KOPYA — kaynak: ari-adisyon-backend/packages/types/src/${file}.\n * Elle değiştirme; \`node scripts/sync-offline-protocol.mjs <backend yolu>\` ile yenile.\n * Sözleşme \`tests/offline-protocol.test.mjs\` içindeki sabit vektörlerle kilitli.\n */\n`;
fs.writeFileSync(path.join(dst, 'protocol.ts'), head('offline.ts') + fs.readFileSync(path.join(src, 'offline.ts'), 'utf8'));
fs.writeFileSync(path.join(dst, 'vectors.ts'), head('offline-vectors.ts') + fs.readFileSync(path.join(src, 'offline-vectors.ts'), 'utf8'));
console.log('protocol.ts ve vectors.ts güncellendi');
