const TZ = 'Europe/Berlin';
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Wandelt einen Zeitpunkt in die Berliner Wandzeit (als UTC-Millisekunden, nur zum Rechnen). */
function berlinWall(ms: number): number {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
}
/** „2026-06-01T14:30“ (Berliner Ortszeit, wie vom Browser-Feld datetime-local) → Date. null bei ungültiger Eingabe. */
export function parseBerlinLocal(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const [y, mo, da, hh, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || hh > 23 || mi > 59 || da < 1 || da > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return null;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  let guess = wall - (berlinWall(wall) - wall);
  guess = wall - (berlinWall(guess) - guess);      // zweiter Durchlauf für Sommer-/Winterzeit-Grenzen
  const d = new Date(guess);
  if (Number.isNaN(d.getTime()) || berlinWall(d.getTime()) !== wall) return null;   // ungültige oder nicht existierende Ortszeit
  return d;
}
/** Beginn des Berliner Kalendertags für den Zeitpunkt `now`. */
export function startOfBerlinDay(now: Date): Date {
  const w = berlinWall(now.getTime());
  const dayWall = Date.UTC(new Date(w).getUTCFullYear(), new Date(w).getUTCMonth(), new Date(w).getUTCDate());
  let guess = dayWall - (berlinWall(dayWall) - dayWall);
  guess = dayWall - (berlinWall(guess) - guess);
  return new Date(guess);
}
export const endOfBerlinDay = (now: Date) => new Date(startOfBerlinDay(new Date(startOfBerlinDay(now).getTime() + 36 * 3600_000)).getTime());
