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
import { loadConfig, type AppConfig } from './core/config.ts';
import { createProviders, type Registry } from './providers/registry.ts';

export type Context = {
  repo: Repo; cfg: AppConfig; registry: Registry; baseUrl: string; now: () => Date;
  leads: LeadStore; runs: RunStore; sales: SalesStore; social: SocialStore; analytics: AnalyticsStore; learning: LearningStore;
  runner: SearchRunner; orders: OrderService; delivery: DeliveryService; maintenance: MaintenanceService; docs: SalesDocs; calls: CallService; contact: ContactService; retention: Retention; notifier: Notifier;
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
  const runner = new SearchRunner({ repo, leads, runs, providers: P, cfg, now });
  const orders = new OrderService(repo, cfg, now);
  const delivery = new DeliveryService(orders);
  const maintenance = new MaintenanceService(repo, P.crawler, now);
  const docs = new SalesDocs({ repo, leads, sales, cfg, baseUrl: o.baseUrl, now });
  const calls = new CallService({ repo, leads, sales, docs, orders, now });
  const contact = new ContactService({ repo, leads, providers: P, now });
  const retention = new Retention(repo, cfg.retention);
  const notifier = new Notifier(repo, P.email, o.baseUrl, now);
  repo.onEvent = (type, leadId, payload) => { void notifier.onEvent(type, leadId, payload); };
  return { repo, cfg, registry, notifier, baseUrl: o.baseUrl, now, leads, runs, sales, social, analytics, learning, runner, orders, delivery, maintenance, docs, calls, contact, retention };
}
