import type { Repo } from '../db/repo.ts';
import type { LeadStore } from '../db/leads.ts';
import type { SalesStore } from '../db/sales.ts';
import type { AppConfig } from '../core/config.ts';
import type { TaskStore } from '../db/tasks.ts';
import type { PipelineStore } from '../db/pipeline.ts';
import { pickTemplate, templateByKey } from '../site/templates.ts';
import { contentFromFacts } from '../site/content.ts';
import { renderDemo, type DemoHints } from '../site/engine.ts';
import { effectiveModules, familyFor, moduleDefs, recommendModules, type Family } from '../site/modules.ts';
import { buildOffer } from '../offers/generate.ts';

/** Erzeugt Demo und Angebot für einen Lead aus den gespeicherten Daten (Fakten, Audit, Branche, Profil). */
export class SalesDocs {
  repo: Repo; leads: LeadStore; sales: SalesStore; cfg: AppConfig; baseUrl: string; now: () => Date; tasks?: TaskStore; pipeline?: PipelineStore;
  constructor(d: { repo: Repo; leads: LeadStore; sales: SalesStore; cfg: AppConfig; baseUrl: string; now?: () => Date; tasks?: TaskStore; pipeline?: PipelineStore }) { this.tasks = d.tasks; this.pipeline = d.pipeline; this.repo = d.repo; this.leads = d.leads; this.sales = d.sales; this.cfg = d.cfg; this.baseUrl = d.baseUrl.replace(/\/$/, ''); this.now = d.now ?? (() => new Date()); }

  /** Baut die Demo-Seite eines Leads aus Fakten, Layout-Familie und gewählten Modulen (noch ohne zu speichern). */
  private async compose(leadId: string, templateKey?: string): Promise<{ html: string; template: string }> {
    const d = await this.leads.get(leadId);
    if (!d) throw new Error('Lead nicht gefunden');
    const facts = await this.leads.factsOf(leadId);
    const sub = this.cfg.taxonomy.sub(d.lead.sub_industry);
    const auto = familyFor(this.cfg, { subIndustry: d.lead.sub_industry, industry: d.lead.industry });
    const family: Family = (d.lead.demo_family as Family | null) ?? auto;
    const famTpl = this.cfg.pipeline.demo.families[family]?.template as string | undefined;
    const useTpl = templateKey && templateKey !== 'auto' ? templateByKey(templateKey)
      : d.lead.demo_family && d.lead.demo_family !== auto && famTpl ? templateByKey(famTpl)
      : pickTemplate({ subIndustry: d.lead.sub_industry, industryText: d.lead.industry, name: d.lead.company_name }, this.cfg.taxonomy);
    const { content, hints } = contentFromFacts(facts, useTpl, this.cfg.taxonomy);
    const booking = d.checks.find((c: any) => c.code === 'ONLINE_BOOKING');
    const mobile = d.opportunity?.dimensions?.mobileNeed?.value ?? null;
    const h: DemoHints = { ...hints, noWebsite: d.lead.website_state === 'none', bookingGap: sub?.booking !== false && (d.lead.website_state === 'none' || booking?.status === 'fail'), mobileWeak: mobile !== null && mobile >= this.cfg.scoring.mobileProblemAt };
    const recommended: string[] = (d.lead.modules_recommended as string[])?.length ? d.lead.modules_recommended : recommendModules(this.cfg, { family, subIndustry: d.lead.sub_industry });
    const modules = effectiveModules(this.cfg, { recommended, selected: d.lead.modules_selected as string[] | null });
    const labels = Object.fromEntries(Object.entries(moduleDefs(this.cfg)).map(([k, v]) => [k, v.label]));
    const social = facts.filter((f) => f.key === 'social').map((f) => f.value as { platform: string; url: string }).filter((v, i, a) => v?.url && a.findIndex((x) => x.url === v.url) === i);
    const whatsapp = facts.find((f) => f.key === 'whatsapp')?.value as string | undefined;
    const html = renderDemo(content, useTpl, this.cfg.agency, h, { plan: { family, modules, moduleLabels: labels }, extras: { social, whatsapp } });
    return { html, template: useTpl.key };
  }

  async demoFor(leadId: string, templateKey?: string, actor = 'user'): Promise<{ id: string; token: string; url: string; template: string }> {
    const { html, template } = await this.compose(leadId, templateKey);
    const created = await this.sales.createDemo(leadId, template, html, this.cfg.agency.demoValidDays ?? 30, actor);
    const d = await this.leads.get(leadId);
    // Erinnerung: Demo fertig → anrufen (nur mit Telefonnummer, nicht bei gesperrten Leads)
    if (this.tasks && d?.lead.phone && !d.lead.contact_blocked) await this.tasks.ensure(leadId, 'CALL_DEMO_READY', 'Demo fertig – anrufen');
    await this.pipeline?.approvals.complete(leadId, 'DEMO_CREATE', { demoId: created.id, actor });
    await this.pipeline?.recomputePriority(leadId);
    return { ...created, url: `${this.baseUrl}/d/${created.token}`, template };
  }

  /** Bestehende Demo (gleicher Link) an geänderte Layout-Familie/Module anpassen. Ohne Demo passiert nichts. */
  async refreshDemo(leadId: string): Promise<boolean> {
    const live = (await this.sales.listDemos(leadId)).find((x: any) => !x.revoked);
    if (!live) return false;
    const { html, template } = await this.compose(leadId, live.template);
    await this.sales.updateDemoHtml(live.id, template, html);
    return true;
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
