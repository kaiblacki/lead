import { humanizeHours } from '../core/hours.ts';
import type { Fact } from '../core/profile.ts';
import { bestFact, factValue } from '../core/profile.ts';
import type { Taxonomy } from '../core/industries.ts';
import type { Template } from './templates.ts';
import type { DemoHints, SiteContent } from './engine.ts';

const plural = (s: string) => s;

/** Baut den Seiteninhalt aus den gespeicherten Fakten. Was nicht bekannt ist, bleibt leer oder wird als Beispiel gekennzeichnet. */
export function contentFromFacts(facts: Fact[], tpl: Template, tax: Taxonomy, opts: { forProduction?: boolean } = {}): { content: SiteContent; hints: DemoHints } {
  const v = <T,>(k: Parameters<typeof factValue>[1]) => factValue<T>(facts, k);
  const name = v<string>('name') ?? 'Ihr Unternehmen';
  const addrFull = v<string>('address');
  const postal = v<string>('postalCode');
  const city = v<string>('city');
  // „Hauptstr. 1, 66333 Völklingen“ → nur die Straße, PLZ und Ort kommen separat
  const street = addrFull ? (postal && addrFull.includes(postal) ? addrFull.split(',')[0].trim() : addrFull) : undefined;
  const hours = v<string[]>('openingHours');
  const known = v<string[]>('services');
  const sub = tax.sub(v<string>('subIndustry'));
  const examples = !known?.length;
  const services = known?.length ? known.slice(0, 8).map((t) => ({ title: plural(t), text: '' })) : tpl.services.map((s) => ({ ...s }));
  const used = new Set<string>();
  for (const k of ['name', 'phone', 'address', 'openingHours', 'services', 'email', 'description'] as const) { const f = bestFact(facts, k); if (f) used.add(f.source); }
  const content: SiteContent = {
    companyName: name, industryLabel: sub?.label, address: street, postalCode: postal, city, phone: v<string>('phone'), email: v<string>('email'),
    openingHours: hours?.length ? hours.map(humanizeHours).join('\n') : undefined, about: v<string>('description'), services, legal: {},
  };
  const dimsNote = (k: string) => facts.find((f) => f.key === (k as never));
  void dimsNote;
  const hints: DemoHints = { servicesAreExamples: examples && !opts.forProduction, sources: [...used].filter((s) => s !== 'computed' && s !== 'search-criteria'), hoursKnown: !!hours?.length };
  return { content, hints };
}
