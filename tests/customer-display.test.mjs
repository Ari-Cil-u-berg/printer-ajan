/**
 * Müşteri ekranı izinleri — yalnızca saf kısımlar: köken doğrulama ve yetkili
 * betiğin ne yazdığı. Kayıt defterine dokunan kısım Windows'ta elle doğrulanır.
 *
 * Neden bu testler: bu izin bir siteye "sormadan pencere ve tam ekran" verir.
 * Yanlış kökene yazılması kimlik avına zemin olur; doğrulamanın reddetmesi
 * gereken örnekler burada yazılı durur.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptPosOrigin, buildPolicyScript } from '../dist/main/customer-display.js';

const API = 'https://api.ariadisyon.com';

test('köken: aynı siteye ait, birebir, https', () => {
  assert.equal(acceptPosOrigin('https://pos.ariadisyon.com', API), 'https://pos.ariadisyon.com');
  assert.equal(acceptPosOrigin('https://pos.x.com.tr', 'https://api.x.com.tr'), 'https://pos.x.com.tr');
  assert.equal(acceptPosOrigin('http://192.168.1.5', 'http://192.168.1.5'), 'http://192.168.1.5');
  assert.equal(acceptPosOrigin('https://ari.local', 'https://ari.local'), 'https://ari.local');
});

test('köken: reddedilmesi gerekenler', () => {
  for (const bad of [
    'https://evil.com',
    'https://*.ariadisyon.com',
    'http://pos.ariadisyon.com',
    'https://pos.ariadisyon.com/yol',
    'https://pos.ariadisyon.com/?q=1',
    'https://u:p@pos.ariadisyon.com',
    'javascript:alert(1)',
    "https://pos.ariadisyon.com'; Remove-Item C:\\",
    '',
    null,
  ]) {
    assert.equal(acceptPosOrigin(bad, API), null, String(bad));
  }
  // `com.tr` ortak diye başka işletmenin alanı geçmez.
  assert.equal(acceptPosOrigin('https://evil.com.tr', 'https://api.x.com.tr'), null);
  // Genel IP'de http yok.
  assert.equal(acceptPosOrigin('http://8.8.8.8', 'http://8.8.8.8'), null);
});

test('betik: yalnızca bilinen anahtarlar ve doğrulanmış köken', () => {
  const chrome = 'HKLM\\SOFTWARE\\Policies\\Google\\Chrome\\PopupsAllowedForUrls';
  const script = buildPolicyScript('add', 'https://pos.ariadisyon.com', [chrome, 'HKLM\\SOFTWARE\\Evil']);
  assert.match(script, /'HKLM:\\SOFTWARE\\Policies\\Google\\Chrome\\PopupsAllowedForUrls'/);
  assert.doesNotMatch(script, /Evil/);
  assert.match(script, /\$origin = 'https:\/\/pos\.ariadisyon\.com'/);
  assert.throws(() => buildPolicyScript('add', 'https://*.evil.com', [chrome]));
});
