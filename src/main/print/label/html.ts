import type { LabelElement, LabelJob, LabelTextSize } from '../../../shared/types';

/**
 * Etiketin HTML'i — ajanın İÇİNDE kurulur; sunucudan gelen metin yalnız kaçışlanmış
 * düz metin olarak girer (HTML/CSS/SVG sunucudan alınmaz). Sayfada betik yok
 * (pencere `javascript:false`), CSP ağı ve dış kaynağı kapatır; logo yalnız
 * doğrulanmış `data:image/png` adresi. Aynı HTML iki yolun ikisine de gider:
 * sürücüye sayfa olarak ve 1 bitlik resme.
 *
 * Ölçüler mm: tarayıcı mm'yi 96 dpi CSS pikseline çevirir. Resim yolunda sayfa CSS `zoom`
 * ile `dpi / 96` büyütülür (`scale`), böylece 1 mm = yazıcının nokta sayısı. Pencerenin
 * yakınlaştırması (`setZoomFactor`) kullanılmaz: yükleme sıfırlıyordu (23.11 duman testi).
 */

/** Yazı boyu, mm (harf yüksekliği ~ yazı boyunun %70'i). Küçük etikette okunur kalsın diye sabit. */
export const LABEL_FONT_MM: Record<LabelTextSize, number> = { S: 2.8, M: 3.8, L: 5.4, XL: 8.5 };

const PADDING_MM = 1.5;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** QR'ın SVG yolu: her siyah modül 1×1 kare (yatay komşular tek dikdörtgende). */
export function qrPath(rows: readonly string[]): string {
  const parts: string[] = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] !== '1') {
        x += 1;
        continue;
      }
      const start = x;
      while (x < row.length && row[x] === '1') x += 1;
      parts.push(`M${start} ${y}h${x - start}v1h-${x - start}z`);
    }
  });
  return parts.join('');
}

/** QR standardının sessiz bölgesi: her kenarda 4 modül (CodeRabbit #14). */
export const QR_QUIET = 4;

/**
 * QR'ın kenarı (mm): modül başına TAM SAYI yazıcı noktası, en az 2 (1 noktalık modül okunmaz).
 * Önce etiketin kısa kenarının yarısı denenir; modül başına 2 nokta düşmüyorsa kenar, etiketin
 * kullanılabilir kısa kenarına kadar büyür. Orada da sığmıyorsa sığan en büyük (en az 1).
 * 177 modüllük QR 50×30 mm / 203 dpi'de yarım kenara (15 mm ≈ 120 nokta) sığmıyordu (CodeRabbit #14).
 */
export function qrSideMm(modules: number, job: Pick<LabelJob, 'widthMm' | 'heightMm' | 'dpi'>): number {
  const total = modules + QR_QUIET * 2;
  const dotsFor = (mm: number) => Math.floor((mm / 25.4) * job.dpi);
  const short = Math.min(job.widthMm, job.heightMm);
  const preferred = Math.floor(dotsFor(short * 0.5) / total);
  const fits = Math.floor(dotsFor(short - PADDING_MM * 2) / total);
  const perModule = Math.max(1, Math.min(Math.max(2, preferred), fits));
  return Math.round(((total * perModule) / job.dpi) * 25.4 * 100) / 100;
}

function element(el: LabelElement, job: LabelJob): string {
  switch (el.type) {
    case 'text': {
      const align = el.align ?? 'center';
      const weight = el.bold ? 700 : 400;
      const size = LABEL_FONT_MM[el.size];
      return `<div class="t" style="font-size:${size}mm;font-weight:${weight};text-align:${align}">${escapeHtml(el.text)}</div>`;
    }
    case 'qr': {
      const n = el.rows.length;
      const side = qrSideMm(n, job);
      return (
        `<div class="c"><svg xmlns="http://www.w3.org/2000/svg" viewBox="-${QR_QUIET} -${QR_QUIET} ${n + QR_QUIET * 2} ${n + QR_QUIET * 2}" ` +
        `style="width:${side}mm;height:${side}mm;flex:none" shape-rendering="crispEdges">` +
        `<path fill="#000" d="${qrPath(el.rows)}"/></svg></div>`
      );
    }
    case 'logo':
      return `<div class="c"><img alt="" src="${el.src}"></div>`;
    case 'line':
      return '<div class="l"></div>';
  }
}

export function labelHtml(job: LabelJob, scale = 1): string {
  const body = job.elements.map((el) => element(el, job)).join('');
  const rotate = job.rotate === 180 ? 'transform:rotate(180deg);' : '';
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<style>
@page{size:${job.widthMm}mm ${job.heightMm}mm;margin:0}
*{box-sizing:border-box;margin:0;padding:0}
html{zoom:${scale}}
html,body{width:${job.widthMm}mm;height:${job.heightMm}mm;overflow:hidden;background:#fff;color:#000}
body{font-family:Arial,Helvetica,"Segoe UI","Liberation Sans",sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.p{width:100%;height:100%;padding:${PADDING_MM}mm;display:flex;flex-direction:column;justify-content:center;gap:0.8mm;${rotate}}
.t{line-height:1.12;overflow-wrap:anywhere;white-space:pre-wrap}
.c{display:flex;justify-content:center}
.c img{max-width:100%;max-height:${Math.max(6, job.heightMm * 0.35)}mm;object-fit:contain}
.l{border-top:0.4mm solid #000}
</style></head><body><div class="p">${body}</div></body></html>`;
}
