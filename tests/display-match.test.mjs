/**
 * Müşteri ekranı monitörünü yeniden bulmak. Electron `Display.id` Windows'ta
 * yeniden başlatma/uykuyla değişiyor; sahada ertesi gün müşteri ekranı yanlış
 * monitörde açıldı. Kural: id tutmazsa izle bul; emin değilsen bulma.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fingerprintOf, matchDisplay } from '../dist/main/display-match.js';

const kasa = { id: 101, label: 'HP 22f', bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
const musteri = { id: 202, label: 'DELL P2419H', bounds: { x: 1920, y: 0, width: 1920, height: 1080 } };
const saved = fingerprintOf(musteri, kasa.id);

test('id tutuyor: o monitör', () => {
  assert.equal(matchDisplay([kasa, musteri], kasa.id, 202, saved), musteri);
});

test('ertesi gün id değişti: izle bulunur', () => {
  const yeni = { ...musteri, id: 999 };
  assert.equal(matchDisplay([{ ...kasa, id: 555 }, yeni], 555, 202, saved), yeni);
});

test('id\'ler yer değiştirdi: id değil iz kazanır', () => {
  const k = { ...kasa, id: 202 };
  const m = { ...musteri, id: 101 };
  assert.equal(matchDisplay([k, m], 202, 202, saved), m);
});

test('müşteri monitörü takılı değil: kasiyer ekranına açılmaz', () => {
  assert.equal(matchDisplay([{ ...kasa, id: 555 }], 555, 202, saved), null);
});

test('aynı model iki ikincil monitör, id değişti: konumla ayrılır', () => {
  const a = { id: 1, label: 'DELL P2419H', bounds: { x: 1920, y: 0, width: 1920, height: 1080 } };
  const b = { id: 2, label: 'DELL P2419H', bounds: { x: 3840, y: 0, width: 1920, height: 1080 } };
  const fp = fingerprintOf({ ...b, id: 77 }, kasa.id);
  assert.equal(matchDisplay([kasa, a, b], kasa.id, 77, fp), b);
});

test('ayırt edilemeyen iki aday: seçilmez', () => {
  const a = { id: 1, label: '', bounds: { x: 1920, y: 0, width: 1920, height: 1080 } };
  const b = { id: 2, label: '', bounds: { x: -1920, y: 0, width: 1920, height: 1080 } };
  const fp = { label: '', x: 5000, y: 0, width: 1920, height: 1080, primary: false };
  assert.equal(matchDisplay([kasa, a, b], kasa.id, 77, fp), null);
});

test('eski kayıt (iz yok): yalnızca id', () => {
  assert.equal(matchDisplay([kasa, musteri], kasa.id, 202, undefined), musteri);
  assert.equal(matchDisplay([kasa, musteri], kasa.id, 303, undefined), null);
});
