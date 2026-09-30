import type { Repo } from '../db/repo.ts';
import type { CrawlerProvider } from '../providers/types.ts';

export type CheckDetails = { url: string; up: boolean; https: boolean | null; loadMs: number | null; hasTel: boolean; hasMail: boolean; brokenPages: string[]; legalMissing: string[]; error: string | null };
const SLOW_MS = 4000;

/** Wartung: regelmäßige Prüfung veröffentlichter Seiten, offene Aufgaben, Monatsbericht. Nutzt den Crawler-Provider (Mock lokal, echt später). */
export class MaintenanceService {
  repo: Repo; crawler: CrawlerProvider; now: () => Date;
  constructor(repo: Repo, crawler: CrawlerProvider, now: () => Date = () => new Date()) { this.repo = repo; this.crawler = crawler; this.now = now; }
  private get pool() { return this.repo.pool; }
  private get owner() { return this.repo.ownerId; }

  async list() {
    return (await this.pool.query(`select p.*, o.lead_id, l.company_name, l.city, d.url as site_url,
        (select count(*)::int from maintenance_tasks t where t.order_id = p.order_id and t.status='OPEN') as open_tasks,
        (select row_to_json(c) from (select ok, details, created_at from maintenance_checks where order_id = p.order_id order by created_at desc limit 1) c) as last_check
      from maintenance_plans p join orders o on o.id = p.order_id join leads l on l.id = o.lead_id
      left join lateral (select url from deployments where order_id = p.order_id order by created_at desc limit 1) d on true
      where p.owner_id = $1 order by p.next_check_at`, [this.owner])).rows;
  }
  async get(orderId: string) {
    const plan = (await this.pool.query(`select p.*, o.lead_id, l.company_name, l.city, d.url as site_url from maintenance_plans p join orders o on o.id = p.order_id join leads l on l.id = o.lead_id
      left join lateral (select url from deployments where order_id = p.order_id order by created_at desc limit 1) d on true where p.order_id=$1 and p.owner_id=$2`, [orderId, this.owner])).rows[0];
    if (!plan) return null;
    const [checks, tasks] = await Promise.all([
      this.pool.query('select ok, details, created_at from maintenance_checks where order_id=$1 and owner_id=$2 order by created_at desc limit 20', [orderId, this.owner]),
      this.pool.query('select * from maintenance_tasks where order_id=$1 and owner_id=$2 order by status, created_at desc limit 50', [orderId, this.owner]),
    ]);
    return { plan, checks: checks.rows, tasks: tasks.rows };
  }
  async planFor(orderId: string) { return (await this.pool.query('select * from maintenance_plans where order_id=$1 and owner_id=$2', [orderId, this.owner])).rows[0] ?? null; }

  async addTask(orderId: string, title: string, detail?: string, source: 'check' | 'manual' | 'customer' = 'manual') {
    const t = title.trim();
    if (!t || t.length > 200) throw new Error('Titel: 1 bis 200 Zeichen');
    await this.pool.query(`insert into maintenance_tasks(owner_id, order_id, title, detail, source) select $1,$2,$3,$4,$5 where not exists (select 1 from maintenance_tasks where order_id=$2 and status='OPEN' and title=$3)`, [this.owner, orderId, t, detail ?? null, source]);
  }
  async completeTask(taskId: string) {
    const r = await this.pool.query("update maintenance_tasks set status='DONE', done_at=now() where id=$1 and owner_id=$2 and status='OPEN' returning order_id", [taskId, this.owner]);
    if (!r.rowCount) throw new Error('Aufgabe nicht gefunden oder schon erledigt');
    return r.rows[0].order_id as string;
  }
  async setPlanStatus(orderId: string, status: 'ACTIVE' | 'PAUSED' | 'CANCELED') {
    const r = await this.pool.query('update maintenance_plans set status=$1 where order_id=$2 and owner_id=$3', [status, orderId, this.owner]);
    if (!r.rowCount) throw new Error('Wartungsplan nicht gefunden');
    await this.repo.event(this.pool, null, 'maintenance_plan_' + status.toLowerCase(), { order_id: orderId, actor: 'user' });
  }

  /** Eine Prüfung ausführen, protokollieren und bei Problemen Aufgaben anlegen. */
  async checkNow(orderId: string): Promise<{ ok: boolean; details: CheckDetails; tasks: string[] }> {
    const dep = (await this.pool.query('select url from deployments where order_id=$1 and owner_id=$2 order by created_at desc limit 1', [orderId, this.owner])).rows[0];
    if (!dep) throw new Error('Keine Veröffentlichung vorhanden');
    const crawl = await this.crawler.crawl(dep.url, { maxPages: 4 });
    const home = crawl.pages[0];
    const html = home?.html ?? '';
    const legal = ['impressum', 'datenschutz'].filter((k) => !crawl.pages.some((p) => p.url.toLowerCase().includes(k) && p.status > 0 && p.status < 400));
    const details: CheckDetails = {
      url: dep.url, up: crawl.ok, https: dep.url.startsWith('https://') ? (crawl.finalUrl ?? '').startsWith('https://') : null, loadMs: home?.loadMs ?? null,
      hasTel: /href=["']tel:/i.test(html), hasMail: /href=["']mailto:/i.test(html),
      brokenPages: crawl.pages.slice(1).filter((p) => p.status >= 400 || p.status === 0).map((p) => { try { return new URL(p.url).pathname; } catch { return p.url; } }),
      legalMissing: crawl.ok ? legal : [], error: crawl.error ?? null,
    };
    const tasks: string[] = [];
    const problem = (title: string, detail?: string) => tasks.push(`${title}${detail ? `||${detail}` : ''}`);
    if (!details.up) problem('Website nicht erreichbar', details.error ?? undefined);
    else {
      if (details.https === false) problem('HTTPS fehlt', 'Die Seite wird nicht über HTTPS ausgeliefert.');
      if (details.loadMs !== null && details.loadMs > SLOW_MS) problem('Seite lädt langsam', `${details.loadMs} ms`);
      if (details.legalMissing.length) problem('Impressum/Datenschutz nicht erreichbar', details.legalMissing.join(', '));
      if (!details.hasTel || !details.hasMail) problem('Kontaktlink fehlt', `${!details.hasTel ? 'Telefon-Link' : ''}${!details.hasTel && !details.hasMail ? ' und ' : ''}${!details.hasMail ? 'E-Mail-Link' : ''} auf der Startseite nicht gefunden`);
      if (details.brokenPages.length) problem('Interne Seite nicht erreichbar', details.brokenPages.join(', '));
    }
    const ok = tasks.length === 0;
    const interval = (await this.planFor(orderId))?.interval_days ?? 7;
    await this.repo.tx(async (c) => {
      await c.query('insert into maintenance_checks(owner_id, order_id, ok, details) values ($1,$2,$3,$4)', [this.owner, orderId, ok, JSON.stringify(details)]);
      await c.query('update maintenance_plans set last_check_at=$1, next_check_at=$2 where order_id=$3 and owner_id=$4', [this.now(), new Date(this.now().getTime() + interval * 86400000), orderId, this.owner]);
      await this.repo.event(c, null, 'maintenance_check', { order_id: orderId, ok, problems: tasks.length, actor: 'system' });
    });
    for (const t of tasks) { const [title, detail] = t.split('||'); await this.addTask(orderId, title, detail, 'check'); }
    return { ok, details, tasks: tasks.map((t) => t.split('||')[0]) };
  }

  /** Alle fälligen Prüfungen ausführen (Kill Switch beachten). */
  async runDue(): Promise<{ checked: number; failed: number }> {
    if ((await this.repo.getLimits()).killSwitch) return { checked: 0, failed: 0 };
    const due = (await this.pool.query("select order_id from maintenance_plans where owner_id=$1 and status='ACTIVE' and next_check_at <= $2 order by next_check_at", [this.owner, this.now()])).rows;
    let failed = 0;
    for (const d of due) { try { const r = await this.checkNow(d.order_id); if (!r.ok) failed++; } catch { failed++; } }
    return { checked: due.length, failed };
  }

  /** Monatsbericht: Verfügbarkeit, Probleme, erledigte/offene Aufgaben. */
  async report(orderId: string, days = 30) {
    const since = new Date(this.now().getTime() - days * 86400000);
    const checks = (await this.pool.query('select ok, details, created_at from maintenance_checks where order_id=$1 and owner_id=$2 and created_at >= $3 order by created_at', [orderId, this.owner, since])).rows;
    const tasks = (await this.pool.query('select title, status, created_at, done_at from maintenance_tasks where order_id=$1 and owner_id=$2 and (created_at >= $3 or status=\'OPEN\') order by created_at', [orderId, this.owner, since])).rows;
    const up = checks.filter((c) => c.details.up).length;
    return { days, checks: checks.length, uptimePct: checks.length ? Math.round((up / checks.length) * 1000) / 10 : null, failures: checks.filter((c) => !c.ok).length, openTasks: tasks.filter((t) => t.status === 'OPEN'), doneTasks: tasks.filter((t) => t.status === 'DONE') };
  }
}
