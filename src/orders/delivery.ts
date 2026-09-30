import { randomBytes } from 'node:crypto';
import type { OrderService, ProjectContent } from './service.ts';
import { templateByKey } from '../templates/index.ts';
import { buildSite, type SiteFiles } from '../production/build.ts';
import { qaLoop, type Issue } from '../qa/check.ts';
import { browserQa } from '../qa/browser.ts';
import type { Deployer } from '../deploy/adapters.ts';
import { fetchSite } from '../auditor/fetch.ts';

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined) || undefined;

export function sanitizeContent(raw: any): ProjectContent {
  const services = (Array.isArray(raw?.services) ? raw.services : []).slice(0, 12)
    .map((s: any) => ({ title: str(s?.title, 80) ?? '', text: str(s?.text, 600) ?? '' })).filter((s: any) => s.title && s.text);
  const name = str(raw?.companyName, 120);
  if (!name) throw new Error('Firmenname fehlt');
  const bookingUrl = str(raw?.bookingUrl, 300);
  if (bookingUrl && !/^https:\/\/[^\s"'<>]+$/.test(bookingUrl)) throw new Error('Buchungs-Link muss mit https:// beginnen');
  const email = str(raw?.email, 120);
  if (email && !/^[^\s@"'<>]+@[^\s@"'<>]+\.[^\s@"'<>]+$/.test(email)) throw new Error('E-Mail-Adresse ist ungültig');
  return {
    companyName: name, industry: str(raw?.industry, 80), address: str(raw?.address, 200), city: str(raw?.city, 80), phone: str(raw?.phone, 40), email,
    openingHours: str(raw?.openingHours, 400), tagline: str(raw?.tagline, 120), about: str(raw?.about, 1500), bookingUrl, services,
    legal: { owner: str(raw?.legal?.owner, 120), vatId: str(raw?.legal?.vatId, 40), register: str(raw?.legal?.register, 120), hosting: str(raw?.legal?.hosting, 120) },
  };
}

export class DeliveryService {
  orders: OrderService;
  constructor(orders: OrderService) { this.orders = orders; }
  private get repo() { return this.orders.repo; }

  async getProject(orderId: string) {
    return (await this.repo.pool.query('select * from projects where order_id=$1 and owner_id=$2', [orderId, this.repo.ownerId])).rows[0] ?? null;
  }
  async latestBuild(orderId: string) {
    return (await this.repo.pool.query(`select b.* from builds b join projects p on p.id=b.project_id where p.order_id=$1 and b.owner_id=$2 order by b.version desc limit 1`, [orderId, this.repo.ownerId])).rows[0] ?? null;
  }

  async saveProject(orderId: string, raw: unknown, legalConfirmed: boolean, template?: string) {
    const content = sanitizeContent(raw);
    const r = await this.repo.pool.query('update projects set content=$1, legal_confirmed=$2, template=coalesce($3, template), updated_at=now() where order_id=$4 and owner_id=$5',
      [JSON.stringify(content), legalConfirmed, template ?? null, orderId, this.repo.ownerId]);
    if (!r.rowCount) throw new Error('Projekt nicht gefunden (Anzahlung noch nicht eingegangen?)');
    await this.repo.event(this.repo.pool, null, 'project_saved', { order_id: orderId, actor: 'user' });
  }

  /** Produziert die Seite, prüft (statisch + Browser), korrigiert automatisch und gibt sie nur bei bestandener QA in die Kundenfreigabe. */
  async build(orderId: string, opts: { browser?: boolean } = {}): Promise<{ version: number; passed: boolean; issues: Issue[]; fixed: string[] }> {
    const order = await this.orders.getOrder(orderId);
    if (!order) throw new Error('Bestellung nicht gefunden');
    if (order.status !== 'IN_PRODUCTION') throw new Error(`Produktion nur im Status IN_PRODUCTION möglich (aktuell ${order.status})`);
    const project = await this.getProject(orderId);
    if (!project) throw new Error('Projekt nicht gefunden');
    const content = project.content as ProjectContent;
    const t = templateByKey(project.template);
    const built = buildSite(content, t, { hosting: content.legal.hosting });
    const qa = qaLoop(built, { content, legalConfirmed: project.legal_confirmed });
    const issues = [...qa.issues];
    if (opts.browser !== false && !issues.some((i) => i.severity === 'error')) issues.push(...(await browserQa(qa.files)));
    const passed = !issues.some((i) => i.severity === 'error');

    return this.repo.tx(async (c) => {
      const v = await c.query('select coalesce(max(version),0)+1 as v from builds where project_id=$1', [project.id]);
      const version = v.rows[0].v as number;
      const b = await c.query('insert into builds(owner_id, project_id, version, files, qa_passed, qa_issues) values ($1,$2,$3,$4,$5,$6) returning id',
        [this.repo.ownerId, project.id, version, JSON.stringify(qa.files), passed, JSON.stringify(issues)]);
      await this.repo.event(c, order.lead_id, 'build_done', { order_id: orderId, version, passed, errors: issues.filter((i) => i.severity === 'error').length, actor: 'system' });
      if (passed) {
        await this.orders.setOrderStatus(c, orderId, 'IN_PRODUCTION', 'CUSTOMER_REVIEW', 'QA bestanden');
        await this.orders.setLeadStatus(c, order.lead_id, 'CUSTOMER_REVIEW', 'QA bestanden');
        await c.query('update orders set review_token = coalesce(review_token, $1) where id=$2 and owner_id=$3', [randomBytes(32).toString('hex'), orderId, this.repo.ownerId]);
        await c.query("insert into reviews(owner_id, order_id, build_id) values ($1,$2,$3)", [this.repo.ownerId, orderId, b.rows[0].id]);
      }
      return { version, passed, issues, fixed: qa.fixed };
    });
  }

  /** Öffentlich per Token: aktuelle Freigabe-Vorschau. */
  async reviewByToken(token: string) {
    if (!/^[0-9a-f]{64}$/.test(token)) return null;
    const r = await this.repo.pool.query(`select o.id as order_id, o.status, o.lead_id, r.id as review_id, r.status as review_status, b.files, l.company_name
      from orders o join reviews r on r.order_id=o.id join builds b on b.id=r.build_id join leads l on l.id=o.lead_id
      where o.review_token=$1 and o.owner_id=$2 order by r.created_at desc limit 1`, [token, this.repo.ownerId]);
    return r.rows[0] ?? null;
  }

  async decide(token: string, decision: 'approve' | 'changes', note?: string): Promise<{ orderId: string }> {
    const rv = await this.reviewByToken(token);
    if (!rv) throw new Error('Freigabe-Link ungültig');
    if (rv.status !== 'CUSTOMER_REVIEW' || rv.review_status !== 'pending') throw new Error('Diese Vorschau wurde bereits entschieden');
    const text = (note ?? '').trim().slice(0, 2000);
    if (decision === 'changes' && text.length < 5) throw new Error('Bitte beschreiben Sie die gewünschte Änderung');
    await this.repo.tx(async (c) => {
      await c.query('update reviews set status=$1, note=$2, decided_at=now() where id=$3 and owner_id=$4', [decision === 'approve' ? 'approved' : 'changes_requested', decision === 'changes' ? text : null, rv.review_id, this.repo.ownerId]);
      if (decision === 'approve') {
        await this.orders.setOrderStatus(c, rv.order_id, 'CUSTOMER_REVIEW', 'APPROVED', 'Kunde hat freigegeben', 'customer');
        await this.orders.setOrderStatus(c, rv.order_id, 'APPROVED', 'FINAL_PAYMENT_PENDING', 'Restzahlung angefordert');
        await this.orders.setLeadStatus(c, rv.lead_id, 'APPROVED', 'Kunde hat freigegeben');
        await this.orders.setLeadStatus(c, rv.lead_id, 'FINAL_PAYMENT', 'Restzahlung angefordert');
      } else {
        await this.orders.setOrderStatus(c, rv.order_id, 'CUSTOMER_REVIEW', 'IN_PRODUCTION', 'Änderung angefordert', 'customer');
        await this.orders.setLeadStatus(c, rv.lead_id, 'PRODUCTION', 'Änderung angefordert');
      }
      await this.repo.event(c, rv.lead_id, decision === 'approve' ? 'customer_approved' : 'customer_changes_requested', { order_id: rv.order_id, note: text || undefined, actor: 'customer' });
    });
    return { orderId: rv.order_id };
  }
  async openChangeRequests(orderId: string) {
    return (await this.repo.pool.query("select note, decided_at from reviews where order_id=$1 and owner_id=$2 and status='changes_requested' order by decided_at desc", [orderId, this.repo.ownerId])).rows;
  }

  /** Veröffentlicht erst nach vollständiger Zahlung und nur den vom Kunden freigegebenen Stand. */
  async deploy(orderId: string, deployer: Deployer) {
    const order = await this.orders.getOrder(orderId);
    if (!order) throw new Error('Bestellung nicht gefunden');
    if (order.status !== 'FULLY_PAID') throw new Error(`Veröffentlichung erst nach vollständiger Zahlung (Status ${order.status})`);
    const r = (await this.repo.pool.query(`select r.build_id, b.files, l.company_name from reviews r join builds b on b.id=r.build_id join leads l on l.id=$2
      where r.order_id=$1 and r.owner_id=$3 and r.status='approved' and b.qa_passed order by r.decided_at desc limit 1`, [orderId, order.lead_id, this.repo.ownerId])).rows[0];
    if (!r) throw new Error('Kein freigegebener Stand mit bestandener QA vorhanden');
    const { url } = await deployer.deploy(r.company_name, r.files as SiteFiles);
    await this.repo.tx(async (c) => {
      await c.query('insert into deployments(owner_id, order_id, build_id, adapter, url) values ($1,$2,$3,$4,$5)', [this.repo.ownerId, orderId, r.build_id, deployer.name, url]);
      await this.orders.setOrderStatus(c, orderId, 'FULLY_PAID', 'DEPLOYED', `Veröffentlicht via ${deployer.name}`);
      await this.orders.setLeadStatus(c, order.lead_id, 'DEPLOYED', 'Veröffentlicht');
    });
    return { url };
  }

  /** Wartungscheck einer veröffentlichten Seite: erreichbar, HTTPS, Ladezeit, interne Links, Kontaktdaten. */
  async maintenanceCheck(orderId: string, fetcher: typeof fetchSite = fetchSite) {
    const dep = (await this.repo.pool.query('select url from deployments where order_id=$1 and owner_id=$2 order by created_at desc limit 1', [orderId, this.repo.ownerId])).rows[0];
    if (!dep) throw new Error('Keine Veröffentlichung vorhanden');
    const res = await fetcher(dep.url);
    const html = res.html ?? '';
    const base = dep.url.replace(/index\.html$/, '');
    const pages = ['impressum.html', 'datenschutz.html'];
    const broken: string[] = [];
    for (const p of pages) { const pr = await fetcher(base + p); if (!pr.ok) broken.push(p); }
    const details = { url: dep.url, up: res.ok, https: (res.finalUrl ?? '').startsWith('https://'), loadMs: res.loadMs ?? null, hasTel: /href=["']tel:/.test(html), hasMail: /href=["']mailto:/.test(html), brokenPages: broken, error: res.error ?? null };
    const ok = details.up && details.brokenPages.length === 0 && details.hasTel && details.hasMail && (dep.url.startsWith('file:') || details.https);
    await this.repo.pool.query('insert into maintenance_checks(owner_id, order_id, ok, details) values ($1,$2,$3,$4)', [this.repo.ownerId, orderId, ok, JSON.stringify(details)]);
    return { ok, details };
  }
}
