import type { Repo } from './db/repo.ts';
import { LeadStore } from './db/leads.ts';
import { RunStore } from './db/runs.ts';
import { SalesStore } from './db/sales.ts';
import { SocialStore } from './db/social.ts';
import { AnalyticsStore } from './db/analytics.ts';
import { LearningStore } from './db/learning.ts';
import { SearchRunner } from './search/runner.ts';
import { OrderService } from './orders/service.ts';
import { DeliveryService } from './orders/delivery.ts';
import { MaintenanceService } from './maintenance/service.ts';
import { CallService } from './calls/service.ts';
import { SalesDocs } from './sales/docs.ts';
import { ContactService } from './contact/service.ts';
import { Retention } from './retention/run.ts';
import { Notifier } from './notify/service.ts';
import { InvoiceService } from './orders/invoice.ts';
import { Gdpr } from './compliance/gdpr.ts';
import { AiUsageStore } from './db/ai-usage.ts';
import { AiGateway } from './ai/gateway.ts';
import { Budget } from './guardrails/budget.ts';
import { AnalysisService } from './analysis/service.ts';
import { TaskStore } from './db/tasks.ts';
import { Automation } from './workflow/automation.ts';
import { PipelineStore } from './db/pipeline.ts';
import { EnrichmentService } from './enrich/service.ts';
import { reanalyzeLead } from './search/reanalyze.ts';
import { createSources, type Sources } from './sources/registry.ts';
import { loadConfig, type AppConfig } from './core/config.ts';
import { createProviders, type Registry } from './providers/registry.ts';

export type Context = {
  repo: Repo; cfg: AppConfig; registry: Registry; baseUrl: string; now: () => Date;
  leads: LeadStore; runs: RunStore; sales: SalesStore; social: SocialStore; analytics: AnalyticsStore; learning: LearningStore;
  pipeline: PipelineStore; sources: Sources; enrichment: EnrichmentService; runner: SearchRunner; orders: OrderService; delivery: DeliveryService; maintenance: MaintenanceService; docs: SalesDocs; calls: CallService; contact: ContactService; retention: Retention; notifier: Notifier; invoices: InvoiceService; gdpr: Gdpr; aiUsage: AiUsageStore; analysis: AnalysisService; tasks: TaskStore; automation: Automation;
  /** KI-Aufruf mit Stufe, Budget-Prüfung und Kostenprotokoll (für Dashboard-Aktionen außerhalb eines Suchlaufs). */
  aiComplete: (leadId: string | null, req: Parameters<AiGateway['complete']>[1]) => ReturnType<AiGateway['complete']>;
};

export type ContextOptions = { env?: Record<string, string | undefined>; baseUrl: string; now?: () => Date; providerNow?: () => Date; cfg?: AppConfig; hostingRoot?: string };

/** Verdrahtet alle Dienste. Einzige Stelle, die entscheidet, welche Provider (Mock/echt) benutzt werden. */
export function buildContext(repo: Repo, o: ContextOptions): Context {
  const env = o.env ?? process.env;
  const now = o.now ?? (() => new Date());
  const cfg = o.cfg ?? loadConfig(env.CONFIG_DIR || 'config');
  const registry = createProviders(env, { baseUrl: o.baseUrl, now: o.providerNow ?? now, hostingRoot: o.hostingRoot ?? env.MOCK_HOSTING_DIR });
  const P = registry.providers;
  const leads = new LeadStore(repo), runs = new RunStore(repo), sales = new SalesStore(repo), social = new SocialStore(repo), analytics = new AnalyticsStore(repo), learning = new LearningStore(repo);
  const pipeline = new PipelineStore({ repo, cfg, now });
  leads.afterSave = (leadId, c) => pipeline.recomputePriority(leadId, c).then(() => undefined);
  const sources = createSources(env, cfg, P, { now: o.providerNow ?? now });
  const enrichment = new EnrichmentService({ repo, leads, pipeline, cfg, now, sources, providers: P, reanalyze: async (id) => { await reanalyzeLead(ctx, id); await automation.afterAnalysis(id, { matched: true, noWebsite: false, opportunity: null, blocked: false }); } });
  const runner = new SearchRunner({ repo, leads, runs, providers: P, cfg, now, pipeline, enrichment: cfg.pipeline.sources.WEB_SEARCH.enabled ? enrichment : undefined });
  const orders = new OrderService(repo, cfg, now);
  const delivery = new DeliveryService(orders);
  const maintenance = new MaintenanceService(repo, P.crawler, now);
  const tasks = new TaskStore(repo);
  const docs = new SalesDocs({ repo, leads, sales, cfg, baseUrl: o.baseUrl, now, tasks, pipeline });
  const calls = new CallService({ repo, leads, sales, docs, orders, now, tasks });
  const contact = new ContactService({ repo, leads, providers: P, now });
  const retention = new Retention(repo, cfg.retention);
  const notifier = new Notifier(repo, P.email, o.baseUrl, now);
  repo.onEvent = (type, leadId, payload) => { void notifier.onEvent(type, leadId, payload); };
  const invoices = new InvoiceService(repo, cfg.agency, cfg.pricing, now);
  const gdpr = new Gdpr(repo, leads);
  const aiUsage = new AiUsageStore(repo);
  const aiComplete: Context['aiComplete'] = async (leadId, req) => {
    const { limits, killSwitch } = await repo.getLimits();
    if (killSwitch) throw new Error('Kill Switch ist aktiv');
    const spent = await aiUsage.spent(now());
    const budget = new Budget(limits, spent);
    return new AiGateway(P.ai, budget, { cfg: cfg.ai, store: aiUsage, env }).complete(leadId, req);
  };
  const analysis = new AnalysisService({ repo, leads, usage: aiUsage, cfg, complete: aiComplete as never, now, aiIsMock: () => P.ai.isMock });
  const automation = new Automation({ repo, docs, cfg, analysis, pipeline });
  runner.afterSave = (leadId, info) => automation.afterAnalysis(leadId, info);
  runner.afterRun = (runId, ids) => automation.afterRun(runId, ids);
  const ctx: Context = { repo, cfg, registry, pipeline, sources, enrichment, notifier, invoices, gdpr, aiUsage, aiComplete, analysis, tasks, automation, baseUrl: o.baseUrl, now, leads, runs, sales, social, analytics, learning, runner, orders, delivery, maintenance, docs, calls, contact, retention };
  return ctx;
}
