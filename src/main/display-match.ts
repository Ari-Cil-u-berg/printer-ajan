/**
 * SEÇİLEN MONİTÖRÜ YENİDEN BULMAK.
 *
 * NEDEN: Electron'un `Display.id`'si Windows'ta kalıcı değil — Chromium onu
 * aygıt adından (`\\.\DISPLAY2`) türetiyor ve bu numara yeniden başlatma,
 * uyku, monitörün kapanıp açılması ya da sürücü sıfırlanmasıyla değişiyor.
 * Sahada: dün seçilen "Ekran 2" bugün tanınmadı, POS tarayıcı yoluna düştü ve
 * müşteri ekranı yanlış monitörde açıldı. Bu yüzden id'nin yanında monitörün
 * kendisini anlatan bir iz saklanır (Windows'un verdiği ad, boyut, konum,
 * birincil mi) ve id tutmazsa monitör bu izle bulunur.
 *
 * TEMKİN: emin olunamıyorsa `null` — yanlış monitörde (özellikle kasiyerin
 * ekranında) tam ekran açmaktan iyidir. Birincil ↔ ikincil arasında tahminle
 * geçilmez; eşit puanlı iki aday varsa seçilmez.
 *
 * Electron'a bağlı değil; test edilebilsin diye ayrı dosyada.
 */

export interface DisplayLike {
  id: number;
  label?: string;
  bounds: { x: number; y: number; width: number; height: number };
}

export interface DisplayFingerprint {
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  primary: boolean;
}

export function fingerprintOf(display: DisplayLike, primaryId: number): DisplayFingerprint {
  const { x, y, width, height } = display.bounds;
  return { label: display.label ?? '', x, y, width, height, primary: display.id === primaryId };
}

export function sameFingerprint(a: DisplayFingerprint | undefined, b: DisplayFingerprint): boolean {
  return (
    a !== undefined &&
    a.label === b.label &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height &&
    a.primary === b.primary
  );
}

/** Kaydedilen seçime karşılık gelen monitör; emin olunamıyorsa `null`. */
export function matchDisplay<T extends DisplayLike>(
  displays: readonly T[],
  primaryId: number,
  savedId: number | undefined,
  saved: DisplayFingerprint | undefined,
): T | null {
  const byId = savedId === undefined ? undefined : displays.find((display) => display.id === savedId);
  // Eski kayıt (iz yok): yalnızca id.
  if (!saved) return byId ?? null;

  let best: T | null = null;
  let bestScore = 0;
  let tie = false;
  for (const display of displays) {
    const fp = fingerprintOf(display, primaryId);
    const samePrimary = fp.primary === saved.primary;
    // Birincil ↔ ikincil arasında tahminle geçilmez; id tutuyorsa geçilir.
    if (!samePrimary && display.id !== savedId) continue;
    const score =
      (saved.label !== '' && fp.label === saved.label ? 8 : 0) +
      (fp.x === saved.x && fp.y === saved.y ? 4 : 0) +
      (display.id === savedId ? 3 : 0) +
      (fp.width === saved.width && fp.height === saved.height ? 2 : 0) +
      (samePrimary ? 1 : 0);
    if (score > bestScore) {
      best = display;
      bestScore = score;
      tie = false;
    } else if (score === bestScore) {
      tie = true;
    }
  }
  return best && !tie ? best : null;
}
