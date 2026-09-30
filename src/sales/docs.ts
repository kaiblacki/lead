import type { Repo } from '../db/repo.ts';
import type { LeadStore } from '../db/leads.ts';
import type { SalesStore } from '../db/sales.ts';
import type { AppConfig } from '../core/config.ts';
import { pickTemplate, templateByKey } from '../site/templates.ts';
import { contentFromFacts } from '../site/content.ts';
import { renderDemo, type DemoHints } from '../site/engine.ts';
import { buildOffer } from '../offers/generate.ts';

/** Erzeugt Demo und Angebot für einen Lead aus den gespeicherten Daten (Fakten, Audit, Branche, Profil). */
export class SalesDocs {
  repo: Repo; leads: LeadStore; sales: SalesStore; cfg: AppConfig; baseUrl: string; now: () => Date;
  constructor(d: { repo: Repo; leads: LeadStore; sales: SalesStore; cfg: AppConfig; baseUrl: string; now?: () => Date }) { this.repo = d.repo; this.leads = d.leads; this.sales = d.sales; this.cfg = d.cfg; this.baseUrl = d.baseUrl.replace(/\/$/, ''); this.now = d.now ?? (() => new Date()); }

  async demoFor(leadId: string, templateKey?: string): Promise<{ id: string; token: string; url: string; template: string }> {
    const d = await this.leads.get(leadId);
    if (!d) throw new Error('Lead nicht gefunden');
    const facts = await this.leads.factsOf(leadId);
    const sub = this.cfg.taxonomy.sub(d.lead.sub_industry);
    const useTpl = templateKey && templateKey !== 'auto' ? templateByKey(templateKey) : pickTemplate({ subIndustry: d.lead.sub_industry, industryText: d.lead.industry, name: d.lead.company_name }, this.cfg.taxonomy);
    const { content, hints } = contentFromFacts(facts, useTpl, this.cfg.taxonomy);
    const booking = d.checks.find((c: any) => c.code === 'ONLINE_BOOKING');
    const mobile = d.opportunity?.dimensions?.mobileNeed?.value ?? null;
    const h: DemoHints = { ...hints, noWebsite: d.lead.website_state === 'none', bookingGap: sub?.booking !== false && (d.lead.website_state === 'none' || booking?.status === 'fail'), mobileWeak: mobile !== null && mobile >= this.cfg.scoring.mobileProblemAt };
    const html = renderDemo(content, useTpl, this.cfg.agency, h);
    const created = await this.sales.createDemo(leadId, useTpl.key, html, this.cfg.agency.demoValidDays ?? 30);
    return { ...created, url: `${this.baseUrl}/d/${created.token}`, template: useTpl.key };
  }

  async offerFor(leadId: string): Promise<{ offerId: string; warnings: string[] }> {
    const d = await this.leads.get(leadId);
    if (!d) throw new Error('Lead nicht gefunden');
    const brief = d.sales?.brief;
    const name: string | undefined = d.sales?.offer_name ?? brief?.service?.name;
    if (!name) throw new Error('Erst eine Verkaufsgrundlage erzeugen (Analyse ausführen).');
    const facts = await this.leads.factsOf(leadId);
    const addr = facts.find((f) => f.key === 'address')?.value as string | undefined;
    const upsellKeys = ((d.opportunity?.upsells ?? []) as { key: string }[]).map((u) => u.key);
    const demos = await this.sales.listDemos(leadId);
    const live = demos.find((x: any) => !x.revoked && new Date(x.expires_at) > this.now());
    const offer = buildOffer({ name: d.lead.company_name, address: addr }, name, this.cfg.pricing, { now: this.now(), upsellKeys, demoUrl: live ? `${this.baseUrl}/d/${live.token}` : undefined });
    const offerId = await this.sales.createOffer(leadId, offer, live?.id ?? null);
    return { offerId, warnings: offer.warnings };
  }
}
