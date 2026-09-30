/** Kleines HTML-Template mit automatischem Escaping: Werte in ${…} werden maskiert, außer sie sind selbst html`…` oder raw(). */
export class Safe { s: string; constructor(s: string) { this.s = s; } toString() { return this.s; } }
export const raw = (s: string) => new Safe(s);
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function part(v: unknown): string {
  if (v instanceof Safe) return v.s;
  if (v === null || v === undefined || v === false || v === true) return '';
  if (Array.isArray(v)) return v.map(part).join('');
  return esc(v);
}
export function html(strings: TemplateStringsArray, ...vals: unknown[]): Safe {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += part(vals[i]) + strings[i + 1];
  return new Safe(out);
}
export const join = (items: Safe[], sep = '') => new Safe(items.map((x) => x.s).join(sep));
export const nl2br = (s: string) => new Safe(esc(s).replace(/\n/g, '<br>'));
