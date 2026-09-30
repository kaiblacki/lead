import type { AIProvider, AiRequest, AiResponse } from '../types.ts';

const block = (prompt: string, tag: string): any => {
  const i = prompt.indexOf(tag + ':');
  if (i < 0) return null;
  const rest = prompt.slice(i + tag.length + 1);
  const start = rest.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let k = start; k < rest.length; k++) {
    if (rest[k] === '{') depth++;
    else if (rest[k] === '}' && --depth === 0) { try { return JSON.parse(rest.slice(start, k + 1)); } catch { return null; } }
  }
  return null;
};

/** Regelbasierte Änderungswünsche → strukturierter Patch. Die echte KI liefert dasselbe JSON-Format. */
export function interpretChangeRules(text: string): { patch: Record<string, unknown>; unclear: string[] } {
  const patch: Record<string, any> = {};
  const unclear: string[] = [];
  const parts = text.split(/\n|;(?=\s*[A-ZÄÖÜa-zäöü]+[^:;]*:)/).map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    let m: RegExpExecArray | null;
    if ((m = /telefon(?:nummer)?[^0-9+]{0,40}(\+?\d[\d\s/()-]{5,})/i.exec(part))) patch.phone = m[1].trim();
    else if ((m = /(?:e-?mail)[^@]{0,40}?([\w.+-]+@[\w-]+\.[\w.-]+)/i.exec(part))) patch.email = m[1];
    else if ((m = /öffnungszeiten[^:]*:\s*([\s\S]+)$/i.exec(part))) patch.openingHours = m[1].split(/\s*\|\s*|\s*;\s*/).join('\n').trim();
    else if ((m = /überschrift[^:]*:\s*(.+)$/i.exec(part))) patch.tagline = m[1].trim();
    else if ((m = /(?:über uns|beschreibung)[^:]*:\s*([\s\S]+)$/i.exec(part))) patch.about = m[1].trim();
    else if ((m = /(?:leistung|angebot)\s+(?:hinzufügen|ergänzen)[^:]*:\s*([^|–-]+?)\s*[|–-]\s*(.+)$/i.exec(part))) patch.addService = { title: m[1].trim(), text: m[2].trim() };
    else if ((m = /(?:leistung|angebot)\s+(?:entfernen|löschen)[^:]*:\s*(.+)$/i.exec(part))) patch.removeService = m[1].trim();
    else if ((m = /(https:\/\/\S+)/i.exec(part)) && /termin|buchung/i.test(part)) patch.bookingUrl = m[1];
    else unclear.push(part);
  }
  return { patch, unclear };
}

/** Deterministischer Ersatz für die KI: arbeitet nur mit den übergebenen Fakten und antwortet im selben JSON-Format wie die echte KI. */
export class MockAIProvider implements AIProvider {
  readonly name = 'mock-ai'; readonly isMock = true; readonly model = 'mock-ai-1';
  calls: AiRequest[] = [];
  async complete(r: AiRequest): Promise<AiResponse> {
    this.calls.push(r);
    const facts = block(r.prompt, 'FACTS_JSON');
    let text: string;
    if (r.task === 'sales_opener' && facts) {
      const reasons: { code: string; text: string }[] = facts.reasons ?? [];
      const first = reasons.slice(0, 2);
      const tail = first.map((x) => x.text.replace(/\.$/, '')).join('; ');
      text = JSON.stringify({ opener: `Guten Tag, hier ist ${facts.sender ?? 'Ihr Ansprechpartner'}. Ich habe mir ${facts.company} online angesehen${tail ? `: ${tail}` : ''}. Darf ich Ihnen in zwei Minuten zeigen, wie das einfacher gehen könnte?`, used_codes: first.map((x) => x.code) });
    } else if (r.task === 'interpret_change' && facts) {
      const { patch, unclear } = interpretChangeRules(String(facts.request ?? ''));
      text = JSON.stringify({ patch, unclear });
    } else text = JSON.stringify({ note: 'mock-ai: keine Regel für diese Aufgabe' });
    return { text, model: this.model, inputTokens: Math.ceil(r.prompt.length / 4), outputTokens: Math.ceil(text.length / 4) };
  }
}
