import { randomBytes } from 'node:crypto';
import type { OrderService, ProjectContent } from './service.ts';
import { buildSite, type SiteFiles } from '../site/engine.ts';
import { templateByKey } from '../site/templates.ts';
import { qaLoop, type Issue } from '../qa/check.ts';
import { browserQa } from '../qa/browser.ts';
import type { AIProvider, HostingProvider } from '../providers/types.ts';

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
  const phone = str(raw?.phone, 40);
  if (phone && !/^[+\d][\d\s/()-]{5,}$/.test(phone)) throw new Error('Telefonnummer ist ungültig');
  return {
    companyName: name, industryLabel: str(raw?.industryLabel, 80), address: str(raw?.address, 200), postalCode: str(raw?.postalCode, 10), city: str(raw?.city, 80), phone, email,
    openingHours: str(raw?.openingHours, 400), tagline: str(raw?.tagline, 120), about: str(raw?.about, 1500), bookingUrl, services,
    legal: { owner: str(raw?.legal?.owner, 120), vatId: str(raw?.legal?.vatId, 40), register: str(raw?.legal?.register, 120), hosting: str(raw?.legal?.hosting, 120) },
  };
}

/** Erlaubte Änderungen, die ein Änderungswunsch bewirken darf (Whitelist). */
export type ContentPatch = Partial<Pick<ProjectContent, 'phone' | 'email' | 'openingHours' | 'tagline' | 'about' | 'address' | 'city' | 'postalCode' | 'bookingUrl'>> & { addService?: { title: string; text: string }; removeService?: string };
const PATCH_KEYS = ['phone', 'email', 'openingHours', 'tagline', 'about', 'address', 'city', 'postalCode', 'bookingUrl', 'addService', 'removeService'];

export function applyPatch(content: ProjectContent, patch: Record<string, unknown>): { content: ProjectContent; applied: string[]; rejected: string[] } {
  const next: any = { ...content, services: [...content.services], legal: { ...content.legal } };
  const applied: string[] = [], rejected: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!PATCH_KEYS.includes(k)) { rejected.push(k); continue; }
    if (k === 'addService') { const s = v as any; if (s && typeof s.title === 'string' && typeof s.text === 'string') { next.services.push({ title: s.title, text: s.text }); applied.push(k); } else rejected.push(k); }
    else if (k === 'removeService') { const before = next.services.length; next.services = next.services.filter((x: any) => x.title.toLowerCase() !== String(v).toLowerCase()); if (next.services.length < before) applied.push(k); else rejected.push(k); }
    else if (typeof v === 'string') { next[k] = v; applied.push(k); } else rejected.push(k);
  }
  return { content: sanitizeContent(next), applied, rejected };
}

export class DeliveryService {
  orders: OrderService;
  constructor(orders: OrderService) { this.orders = orders; }
  private get repo() { return this.orders.repo; }

  async getProject(orderId: string) { return (await this.repo.pool.query('select * from projects where order_id=$1 and owner_id=$2', [orderId, this.repo.ownerId])).rows[0] ?? null; }
  async latestBuild(orderId: string) { return (await this.repo.pool.query(`select b.* from builds b join projects p on p.id=b.project_id where p.order_id=$1 and b.owner_id=$2 order by b.version desc limit 1`, [orderId, this.repo.ownerId])).rows[0] ?? null; }

  async saveProject(orderId: string, raw: unknown, legalConfirmed: boolean, template?: string) {
    const content = sanitizeContent(raw);
    const r = await this.repo.pool.query('update projects set content=$1, legal_confirmed=$2, template=coalesce($3, template), updated_at=now() where order_id=$4 and owner_id=$5', [JSON.stringify(content), legalConfirmed, template ?? null, orderId, this.repo.ownerId]);
    if (!r.rowCount) throw new Error('Projekt nicht gefunden (Anzahlung noch nicht eingegangen?)');
    await this.repo.event(this.repo.pool, null, 'project_saved', { order_id: orderId, actor: 'user' });
  }

  /**
   * Produktion → QA → Kundenfreigabe. Status sichtbar: PRODUCTION → QA → CUSTOMER_REVIEW (oder zurück nach PRODUCTION mit den Fehlern).
   * Behebbare Fehler korrigiert die QA automatisch und prüft erneut; nur bei bestandener QA geht die Seite in die Freigabe.
   */
  async build(orderId: string, opts: { browser?: boolean; actor?: string } = {}): Promise<{ version: number; passed: boolean; issues: Issue[]; fixed: string[] }> {
    const order = await this.orders.getOrder(orderId);
    if (!order) throw new Error('Bestellung nicht gefunden');
    if (order.status !== 'IN_PRODUCTION' && order.status !== 'QA') throw new Error(`Produktion nur im Status IN_PRODUCTION möglich (aktuell ${order.status})`);
    const project = await this.getProject(orderId);
    if (!project) throw new Error('Projekt nicht gefunden');
    const actor = opts.actor ?? 'system';
    if (order.status === 'IN_PRODUCTION') await this.repo.tx(async (c) => {
      await this.orders.setOrderStatus(c, orderId, 'IN_PRODUCTION', 'QA', 'Seite gebaut, QA läuft', actor);
      await this.orders.setLeadStatus(c, order.lead_id, 'QA', 'QA läuft', actor);
    });
    let result: { qa: ReturnType<typeof qaLoop>; issues: Issue[]; passed: boolean };
    try {
      const content = project.content as ProjectContent;
      const built = buildSite(content, templateByKey(project.template), { hosting: content.legal.hosting });
      const qa = qaLoop(built, { content, legalConfirmed: project.legal_confirmed });
      const issues = [...qa.issues];
      if (opts.browser !== false && !issues.some((i) => i.severity === 'error')) issues.push(...(await browserQa(qa.files)));
      result = { qa, issues, passed: !issues.some((i) => i.severity === 'error') };
    } catch (e) {
      await this.repo.tx(async (c) => { await this.orders.setOrderStatus(c, orderId, 'QA', 'IN_PRODUCTION', 'QA-Fehler', actor); await this.orders.setLeadStatus(c, order.lead_id, 'PRODUCTION', 'QA-Fehler', actor); });
      throw e;
    }
    const { qa, issues, passed } = result;
    return this.repo.tx(async (c) => {
      const v = await c.query('select coalesce(max(version),0)+1 as v from builds where project_id=$1', [project.id]);
      const version = v.rows[0].v as number;
      const b = await c.query('insert into builds(owner_id, project_id, version, files, qa_passed, qa_issues) values ($1,$2,$3,$4,$5,$6) returning id', [this.repo.ownerId, project.id, version, JSON.stringify(qa.files), passed, JSON.stringify(issues)]);
      await this.repo.event(c, order.lead_id, 'build_done', { order_id: orderId, version, passed, errors: issues.filter((i) => i.severity === 'error').length, fixed: qa.fixed.length, actor });
      if (passed) {
        await this.orders.setOrderStatus(c, orderId, 'QA', 'CUSTOMER_REVIEW', 'QA bestanden', actor);
        await this.orders.setLeadStatus(c, order.lead_id, 'CUSTOMER_REVIEW', 'QA bestanden', actor);
        await c.query('update orders set review_token = coalesce(review_token, $1) where id=$2 and owner_id=$3', [randomBytes(32).toString('hex'), orderId, this.repo.ownerId]);
        await c.query('insert into reviews(owner_id, order_id, build_id) values ($1,$2,$3)', [this.repo.ownerId, orderId, b.rows[0].id]);
      } else {
        await this.orders.setOrderStatus(c, orderId, 'QA', 'IN_PRODUCTION', 'QA nicht bestanden – Fehler beheben', actor);
        await this.orders.setLeadStatus(c, order.lead_id, 'PRODUCTION', 'QA nicht bestanden', actor);
      }
      return { version, passed, issues, fixed: qa.fixed };
    });
  }

  /** Öffentlich per Token: aktuelle Freigabe-Vorschau. */
  async reviewByToken(token: string) {
    if (!/^[0-9a-f]{64}$/.test(token)) return null;
    const r = await this.repo.pool.query(`select o.id as order_id, o.status, o.lead_id, r.id as review_id, r.status as review_status, r.change_status, b.files, l.company_name
      from orders o join reviews r on r.order_id=o.id join builds b on b.id=r.build_id join leads l on l.id=o.lead_id
      where o.review_token=$1 and o.owner_id=$2 order by r.created_at desc limit 1`, [token, this.repo.ownerId]);
    return r.rows[0] ?? null;
  }

  /** Freigabe oder Änderungswunsch des Kunden. Bei Änderung: Status zurück auf Produktion, Wunsch gespeichert. */
  async decide(token: string, decision: 'approve' | 'changes', note?: string): Promise<{ orderId: string; reviewId: string }> {
    const rv = await this.reviewByToken(token);
    if (!rv) throw new Error('Freigabe-Link ungültig');
    if (rv.status !== 'CUSTOMER_REVIEW' || rv.review_status !== 'pending') throw new Error('Diese Vorschau wurde bereits entschieden');
    const text = (note ?? '').trim().slice(0, 2000);
    if (decision === 'changes' && text.length < 5) throw new Error('Bitte beschreiben Sie die gewünschte Änderung');
    await this.repo.tx(async (c) => {
      await c.query("update reviews set status=$1, note=$2, decided_at=now(), change_status=$3 where id=$4 and owner_id=$5", [decision === 'approve' ? 'approved' : 'changes_requested', decision === 'changes' ? text : null, decision === 'changes' ? 'OPEN' : null, rv.review_id, this.repo.ownerId]);
      if (decision === 'approve') {
        await this.orders.setOrderStatus(c, rv.order_id, 'CUSTOMER_REVIEW', 'APPROVED', 'Kunde hat freigegeben', 'customer');
        await this.orders.setOrderStatus(c, rv.order_id, 'APPROVED', 'FINAL_PAYMENT_PENDING', 'Restzahlung angefordert');
        await this.orders.setLeadStatus(c, rv.lead_id, 'APPROVED', 'Kunde hat freigegeben', 'customer');
        await this.orders.setLeadStatus(c, rv.lead_id, 'FINAL_PAYMENT', 'Restzahlung angefordert');
      } else {
        await this.orders.setOrderStatus(c, rv.order_id, 'CUSTOMER_REVIEW', 'IN_PRODUCTION', 'Änderung angefordert', 'customer');
        await this.orders.setLeadStatus(c, rv.lead_id, 'PRODUCTION', 'Änderung angefordert', 'customer');
      }
      await this.repo.event(c, rv.lead_id, decision === 'approve' ? 'customer_approved' : 'customer_changes_requested', { order_id: rv.order_id, note: text || undefined, actor: 'customer' });
    });
    return { orderId: rv.order_id, reviewId: rv.review_id };
  }

  async openChangeRequests(orderId: string) {
    return (await this.repo.pool.query("select id, note, decided_at, change_status, change_patch, change_unclear from reviews where order_id=$1 and owner_id=$2 and status='changes_requested' order by decided_at desc", [orderId, this.repo.ownerId])).rows;
  }

  /**
   * Änderungswunsch automatisch umsetzen: KI → strukturierter Patch (nur erlaubte Felder) → speichern → QA → neue Vorschau.
   * Bleibt etwas unklar oder wird der Patch abgelehnt, ändert sich nichts und der Wunsch wird zur manuellen Bearbeitung markiert.
   */
  async processChange(reviewId: string, ai: { complete: (leadId: string, r: Parameters<AIProvider['complete']>[0]) => Promise<{ text: string }> }, opts: { browser?: boolean } = {}): Promise<{ status: 'APPLIED' | 'MANUAL'; build?: Awaited<ReturnType<DeliveryService['build']>>; unclear: string[] }> {
    const rv = (await this.repo.pool.query("select r.*, o.lead_id from reviews r join orders o on o.id=r.order_id where r.id=$1 and r.owner_id=$2 and r.status='changes_requested'", [reviewId, this.repo.ownerId])).rows[0];
    if (!rv) throw new Error('Änderungswunsch nicht gefunden');
    const order = await this.orders.getOrder(rv.order_id);
    const project = await this.getProject(rv.order_id);
    if (order.status !== 'IN_PRODUCTION' || !project) throw new Error('Änderung kann nur in der Produktion umgesetzt werden');
    const markManual = async (unclear: string[], patch: object = {}) => {
      await this.repo.pool.query("update reviews set change_status='MANUAL', change_patch=$1, change_unclear=$2 where id=$3", [JSON.stringify(patch), JSON.stringify(unclear), reviewId]);
      await this.repo.event(this.repo.pool, rv.lead_id, 'change_manual', { review_id: reviewId, unclear, actor: 'system' });
      return { status: 'MANUAL' as const, unclear };
    };
    const prompt = ['Du setzt Änderungswünsche eines Kunden für eine statische Firmen-Website um.', 'Gib ausschließlich JSON zurück: {"patch": {...}, "unclear": ["..."]}.',
      `Erlaubte Felder im patch: ${PATCH_KEYS.join(', ')}. Alles, was du nicht sicher umsetzen kannst (Bilder, Layout, Farben, neue Seiten), kommt in "unclear". Erfinde keine Inhalte.`,
      'FACTS_JSON:', JSON.stringify({ request: rv.note, content: project.content })].join('\n');
    let parsed: { patch?: Record<string, unknown>; unclear?: string[] };
    try {
      const res = await ai.complete(rv.lead_id, { task: 'interpret_change', prompt, maxTokens: 500 });
      parsed = JSON.parse(res.text.slice(res.text.indexOf('{'), res.text.lastIndexOf('}') + 1));
    } catch { return markManual(['Der Änderungswunsch konnte nicht automatisch interpretiert werden.']); }
    const patch = parsed.patch && typeof parsed.patch === 'object' ? parsed.patch : {};
    const unclear = Array.isArray(parsed.unclear) ? parsed.unclear.map(String) : [];
    if (!Object.keys(patch).length || unclear.length) return markManual(unclear.length ? unclear : ['Kein umsetzbarer Änderungswunsch erkannt.'], patch);
    let next: ReturnType<typeof applyPatch>;
    try { next = applyPatch(project.content as ProjectContent, patch); } catch (e) { return markManual([`Änderung abgelehnt: ${e instanceof Error ? e.message : String(e)}`], patch); }
    if (next.rejected.length || !next.applied.length) return markManual([`Nicht umsetzbar: ${next.rejected.join(', ') || 'keine Änderung'}`], patch);
    await this.repo.pool.query('update projects set content=$1, updated_at=now() where order_id=$2 and owner_id=$3', [JSON.stringify(next.content), rv.order_id, this.repo.ownerId]);
    await this.repo.pool.query("update reviews set change_status='APPLIED', change_patch=$1, change_unclear='[]', resolved_at=now() where id=$2", [JSON.stringify(patch), reviewId]);
    await this.repo.event(this.repo.pool, rv.lead_id, 'change_applied', { review_id: reviewId, fields: next.applied, actor: 'system' });
    const build = await this.build(rv.order_id, { browser: opts.browser, actor: 'system' });
    return { status: 'APPLIED', build, unclear: [] };
  }

  /** Veröffentlicht erst nach vollständiger Zahlung und nur den vom Kunden freigegebenen Stand. */
  async deploy(orderId: string, hosting: HostingProvider) {
    const order = await this.orders.getOrder(orderId);
    if (!order) throw new Error('Bestellung nicht gefunden');
    if (order.status !== 'FULLY_PAID') throw new Error(`Veröffentlichung erst nach vollständiger Zahlung (Status ${order.status})`);
    const r = (await this.repo.pool.query(`select r.build_id, b.files, l.company_name from reviews r join builds b on b.id=r.build_id join leads l on l.id=$2
      where r.order_id=$1 and r.owner_id=$3 and r.status='approved' and b.qa_passed order by r.decided_at desc limit 1`, [orderId, order.lead_id, this.repo.ownerId])).rows[0];
    if (!r) throw new Error('Kein freigegebener Stand mit bestandener QA vorhanden');
    const { url } = await hosting.deploy(r.company_name, r.files as SiteFiles);
    await this.repo.tx(async (c) => {
      await c.query('insert into deployments(owner_id, order_id, build_id, adapter, url) values ($1,$2,$3,$4,$5)', [this.repo.ownerId, orderId, r.build_id, hosting.name, url]);
      await this.orders.setOrderStatus(c, orderId, 'FULLY_PAID', 'DEPLOYED', `Veröffentlicht via ${hosting.name}`);
      await this.orders.setLeadStatus(c, order.lead_id, 'DEPLOYED', 'Veröffentlicht');
    });
    return { url };
  }
}
