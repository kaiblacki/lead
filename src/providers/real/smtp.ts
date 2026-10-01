import net from 'node:net';
import tls from 'node:tls';
import type { EmailProvider, OutboundMessage, SendResult } from '../types.ts';

export type SmtpConfig = { host: string; port: number; secure: boolean; user?: string; pass?: string; from: string; timeoutMs?: number };
const CTL = /[\r\n\0]/;
const addr = (a: string) => { if (CTL.test(a) || !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(a)) throw new Error(`Ungültige E-Mail-Adresse: ${a.slice(0, 60)}`); return a; };
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const wrap = (s: string) => s.replace(/(.{76})/g, '$1\r\n');

/** Baut eine MIME-Nachricht (UTF-8, Base64-Text). Kopfzeilen werden gegen Einschleusung geprüft. */
export function buildMime(from: string, m: OutboundMessage, id: string, date = new Date()): string {
  const subject = m.subject ?? '';
  if (CTL.test(subject)) throw new Error('Betreff darf keine Zeilenumbrüche enthalten');
  const fromAddr = /<([^>]+)>/.exec(from)?.[1] ?? from; addr(fromAddr);
  const head = [`From: ${from.replace(/[\r\n]/g, ' ')}`, `To: ${addr(m.to)}`, `Subject: =?UTF-8?B?${b64(subject)}?=`, `Date: ${date.toUTCString()}`, `Message-ID: <${id}@${fromAddr.split('@')[1]}>`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', 'X-Mailer: AI Agency OS'];
  return head.join('\r\n') + '\r\n\r\n' + wrap(b64(m.text));
}

type Conn = { sock: net.Socket | tls.TLSSocket; buf: string };

/** Minimaler SMTP-Client (implizites TLS auf 465 oder STARTTLS auf 587; AUTH nur über verschlüsselte Verbindung). */
export class SmtpEmailProvider implements EmailProvider {
  readonly name = 'smtp'; readonly isMock = false;
  cfg: SmtpConfig;
  constructor(cfg: SmtpConfig) { this.cfg = cfg; }

  private reply(c: Conn, timeoutMs: number): Promise<{ code: number; lines: string[] }> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { cleanup(); reject(new Error('SMTP: Zeitüberschreitung')); }, timeoutMs);
      const check = () => {
        const lines = c.buf.split('\r\n');
        for (let i = 0; i < lines.length - 1; i++) {
          if (/^\d{3} /.test(lines[i])) { const used = lines.slice(0, i + 1); c.buf = lines.slice(i + 1).join('\r\n'); cleanup(); return resolve({ code: Number(used[i].slice(0, 3)), lines: used }); }
        }
      };
      const onData = (d: Buffer) => { c.buf += d.toString('utf8'); check(); };
      const onErr = (e: Error) => { cleanup(); reject(e); };
      const onClose = () => { cleanup(); reject(new Error('SMTP: Verbindung geschlossen')); };
      const cleanup = () => { clearTimeout(t); c.sock.off('data', onData); c.sock.off('error', onErr); c.sock.off('close', onClose); };
      c.sock.on('data', onData); c.sock.on('error', onErr); c.sock.on('close', onClose); check();
    });
  }
  private async cmd(c: Conn, line: string, ok: number[], t: number) {
    if (CTL.test(line.replace(/\r\n$/, ''))) throw new Error('SMTP: ungültiger Befehl');
    c.sock.write(line + '\r\n'); const r = await this.reply(c, t);
    if (!ok.includes(r.code)) throw new Error(`SMTP ${r.code}: ${r.lines.at(-1)?.slice(4, 120)}`);
    return r;
  }

  async send(m: OutboundMessage): Promise<SendResult> {
    const { host, port, secure, user, pass, from } = this.cfg; const t = this.cfg.timeoutMs ?? 15000;
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const fromAddr = addr(/<([^>]+)>/.exec(from)?.[1] ?? from);
    const mime = buildMime(from, m, id);
    const open = () => new Promise<net.Socket>((res, rej) => { const s = secure ? tls.connect({ host, port, servername: host }, () => res(s)) : net.connect({ host, port }, () => res(s)); s.once('error', rej); }) as Promise<net.Socket>;
    const c: Conn = { sock: await open(), buf: '' };
    try {
      let r = await this.reply(c, t); if (r.code !== 220) throw new Error(`SMTP ${r.code}`);
      const ehlo = async () => (await this.cmd(c, 'EHLO agency-os.local', [250], t)).lines.join(' ').toUpperCase();
      let caps = await ehlo(); let encrypted = secure;
      if (!secure && caps.includes('STARTTLS')) {
        await this.cmd(c, 'STARTTLS', [220], t);
        c.sock.removeAllListeners('error');
        c.sock = await new Promise<tls.TLSSocket>((res, rej) => { const s = tls.connect({ socket: c.sock as net.Socket, servername: host }, () => res(s)); s.once('error', rej); });
        c.buf = ''; encrypted = true; caps = await ehlo();
      }
      if (user) {
        const local = ['127.0.0.1', 'localhost', '::1'].includes(host);
        if (!encrypted && !local) throw new Error('SMTP: Server bietet keine Verschlüsselung (STARTTLS) – Zugangsdaten werden nicht unverschlüsselt gesendet');
        await this.cmd(c, 'AUTH PLAIN ' + b64(`\0${user}\0${pass ?? ''}`), [235], t);
      }
      await this.cmd(c, `MAIL FROM:<${fromAddr}>`, [250], t);
      await this.cmd(c, `RCPT TO:<${addr(m.to)}>`, [250, 251], t);
      await this.cmd(c, 'DATA', [354], t);
      c.sock.write(mime.replace(/^\./gm, '..') + '\r\n.\r\n'); r = await this.reply(c, t);
      if (r.code !== 250) throw new Error(`SMTP ${r.code}: ${r.lines.at(-1)?.slice(4, 120)}`);
      try { c.sock.write('QUIT\r\n'); } catch { /* egal */ }
      return { id, status: 'sent' };
    } finally { c.sock.destroy(); }
  }
}
