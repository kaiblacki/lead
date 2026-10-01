const DAY: Record<string, string> = { Mo: 'Mo', Tu: 'Di', We: 'Mi', Th: 'Do', Fr: 'Fr', Sa: 'Sa', Su: 'So', PH: 'Feiertage' };
const dayPart = (s: string): (string | null)[] => s.split(',').map((d) => { const p = d.trim().split('-').map((x) => DAY[x]); return p.some((x) => !x) ? null : p.join('–'); });

/** OpenStreetMap-Öffnungszeiten („Mo-Fr 10:00-18:00; Sa 10:00-16:00; PH,Su off“) lesbar auf Deutsch. Was nicht eindeutig lesbar ist, bleibt unverändert – nichts wird geraten. */
export function humanizeHours(raw: string): string {
  const rules = raw.split(';').map((r) => r.trim()).filter(Boolean);
  const out: string[] = [];
  for (const r of rules) {
    const m = /^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su|PH)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?)(?:,\s*(?:Mo|Tu|We|Th|Fr|Sa|Su|PH)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?)*)\s+(off|\d{1,2}:\d{2}-\d{1,2}:\d{2}(?:,\s*\d{1,2}:\d{2}-\d{1,2}:\d{2})*)$/.exec(r);
    if (!m) return raw;
    const days = dayPart(m[1]); if (days.includes(null)) return raw;
    const time = m[2] === 'off' ? 'geschlossen' : m[2].split(',').map((t) => t.trim().replace('-', '–')).join(' und ') + ' Uhr';
    out.push(`${days.join(', ')}: ${time}`);
  }
  return out.length ? out.join('\n') : raw;
}
