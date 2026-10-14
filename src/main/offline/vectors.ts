/** KOPYA — kaynak: ari-adisyon-backend/packages/types/src/offline-vectors.ts. */
/**
 * Çevrimdışı protokolün SABİT test vektörleri. Sunucu (`offline-keys.spec.ts`),
 * ajan, kasa ve mobil kendi kripto kütüphaneleriyle bu girdilerden bu çıktıları
 * üretmek ZORUNDA — biri değişirse hepsinin testi kırılır. Elle değiştirilmez;
 * tarif değişirse yeniden üretilir ve dört taraf birlikte güncellenir.
 */
export const OFFLINE_TEST_VECTORS = {
  rootSecret: 'test-offline-root-secret-0123456789abcdef',
  tenantId: 'tenant-1',
  branchId: 'branch-1',
  keyVersion: 3,
  hubKey: '_rRg97_I6dH5LcGmFJKagxVUnsviPAPEpC-Bp5myBDQ',
  claims: {
    v: 1,
    gid: '00112233445566778899aabbccddeeff',
    tid: 'tenant-1',
    bid: 'branch-1',
    uid: '0190a0b0-0000-7000-8000-000000000001',
    name: 'Ayşe Y.',
    perms: ['order:create', 'payment:collect'],
    kv: 3,
    iat: 1760400000,
    exp: 1760486400,
  },
  token:
    'eyJ2IjoxLCJnaWQiOiIwMDExMjIzMzQ0NTU2Njc3ODg5OWFhYmJjY2RkZWVmZiIsInRpZCI6InRlbmFudC0xIiwiYmlkIjoiYnJhbmNoLTEiLCJ1aWQiOiIwMTkwYTBiMC0wMDAwLTcwMDAtODAwMC0wMDAwMDAwMDAwMDEiLCJuYW1lIjoiQXnFn2UgWS4iLCJwZXJtcyI6WyJvcmRlcjpjcmVhdGUiLCJwYXltZW50OmNvbGxlY3QiXSwia3YiOjMsImlhdCI6MTc2MDQwMDAwMCwiZXhwIjoxNzYwNDg2NDAwfQ.PgvbGM4v6-VlRfhidQ--D2wpx-6ElZH9udm5PmXr_vE',
  secret: 'lMPd_l0xQN9FdNG_FiVrKweNI2U04QCcrfHqFVBqcpU',
  op: {
    opId: '0190a0b0-0000-7000-8000-0000000000aa',
    at: '2026-10-14T10:00:00.000Z',
    by: '0190a0b0-0000-7000-8000-000000000001',
    kind: 'OPEN_TABLE',
    orderRef: 'local:0190a0b0-0000-7000-8000-0000000000bb',
    tableId: '0190a0b0-0000-7000-8000-0000000000cc',
    guestCount: 2,
  },
  canonicalOp:
    '{"at":"2026-10-14T10:00:00.000Z","by":"0190a0b0-0000-7000-8000-000000000001","guestCount":2,"kind":"OPEN_TABLE","opId":"0190a0b0-0000-7000-8000-0000000000aa","orderRef":"local:0190a0b0-0000-7000-8000-0000000000bb","tableId":"0190a0b0-0000-7000-8000-0000000000cc"}',
  mac: '8z1hfcv6xFW3RGlPLe5t-ewZGzNgXZWgXEu9ffr_3q4',
  envelope: {
    method: 'POST',
    path: '/v1/ops',
    t: 1760436000000,
    nonceHex: '000102030405060708090a0b',
    /** Düz metin: `JSON.stringify({ ops: [op] })` (alan sırası `op` ile aynı). */
    c: 'kEE0jm7PO3HPmYBA7WiXy_RZFMlqsn8heh4O64vi7Bu_c2lz7E4Gt0mW3eVpiNRtuQnZvKuppK0K98H9pLsyDx_8nLJd9-ca1nhyly01Dld7ODCGTxHTSt-xSXQ1jR9iAmFOUsB4VW3lTPhYi9xybd9DQlktVElCf2GQDFLYAXieaRATSRTmi4b9dQBGG5fP-Rx0I8O2TgdS0siNEvxO6rq9vja6X_UjKsptc8Bad8kqMM7glPWSm8kZK3fuK3zK85VsLNBJNZgI84q20N6S8qBtiNKavlLVgUnxoTZJNURKzCxHI4mIF1eIHVvT9G9_JrLoO1jIFM2YD31t8q6nah6aVpyZhp_jYBbNCJ0pOQrsKH7jE4MHxvFw3tki5hHx0Q',
  },
} as const;
