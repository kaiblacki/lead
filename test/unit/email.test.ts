import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { SmtpEmailProvider, buildMime } from '../../src/providers/real/smtp.ts';
import { createProviders } from '../../src/providers/registry.ts';

/** Minimaler Fake-SMTP-Server (ohne TLS) – nur für localhost. */
function fakeSmtp(opts: { auth?: boolean; rejectRcpt?: boolean } = {}) {
  const log: string[] = []; let data = '';
  const server = net.createServer((s) => {
    let inData = false, buf = '';
    s.write('220 fake ESMTP\r\n');
    s.on('data', (d) => {
      buf += d.toString();
      let i: number;
      while (inData ? (i = buf.indexOf('\r\n.\r\n')) >= 0 : (i = buf.indexOf('\r\n')) >= 0) {
        if (inData) { data = buf.slice(0, i); buf = buf.slice(i + 5); inData = false; s.write('250 queued\r\n'); continue; }
        const line = buf.slice(0, i); buf = buf.slice(i + 2); log.push(line);
        if (/^EHLO/.test(line)) s.write('250-fake\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH PLAIN/.test(line)) s.write(Buffer.from(line.slice(11), 'base64').toString() === '\0u\0p' ? '235 ok\r\n' : '535 bad\r\n');
        else if (/^MAIL FROM/.test(line)) s.write('250 ok\r\n');
        else if (/^RCPT TO/.test(line)) s.write(opts.rejectRcpt ? '550 no such user\r\n' : '250 ok\r\n');
        else if (line === 'DATA') { inData = true; s.write('354 go\r\n'); }
        else if (line === 'QUIT') s.end('221 bye\r\n');
      }
    });
  });
  return new Promise<{ port: number; log: string[]; data: () => string; close: () => void }>((res) => server.listen(0, '127.0.0.1', () => res({ port: (server.address() as net.AddressInfo).port, log, data: () => data, close: () => server.close() })));
}

test('SMTP: Nachricht wird zugestellt (Umlaute, Punkt-Zeilen), Anmeldung und Absender korrekt', async () => {
  const srv = await fakeSmtp();
  try {
    const p = new SmtpEmailProvider({ host: '127.0.0.1', port: srv.port, secure: false, user: 'u', pass: 'p', from: 'Agentur <info@agentur.example>' });
    const r = await p.send({ to: 'kunde@beispiel.example', subject: 'Zahlungslink für Müller & Söhne', text: 'Guten Tag,\n.\nPunkt-Zeile ü ß €' });
    assert.equal(r.status, 'sent'); assert.equal(p.isMock, false);
    assert.ok(srv.log.some((l) => l === 'MAIL FROM:<info@agentur.example>') && srv.log.some((l) => l === 'RCPT TO:<kunde@beispiel.example>'));
    const m = srv.data();
    assert.match(m, /^From: Agentur <info@agentur\.example>/m); assert.match(m, /^To: kunde@beispiel\.example/m);
    const subj = /Subject: =\?UTF-8\?B\?([^?]+)\?=/.exec(m)![1]; assert.equal(Buffer.from(subj, 'base64').toString(), 'Zahlungslink für Müller & Söhne');
    const body = m.split('\r\n\r\n')[1].replace(/\r\n/g, ''); assert.equal(Buffer.from(body, 'base64').toString(), 'Guten Tag,\n.\nPunkt-Zeile ü ß €');
  } finally { srv.close(); }
});

test('SMTP: falsche Zugangsdaten, abgelehnter Empfänger und Header-Einschleusung werden sauber abgelehnt', async () => {
  const srv = await fakeSmtp();
  const bad = await fakeSmtp({ rejectRcpt: true });
  try {
    await assert.rejects(new SmtpEmailProvider({ host: '127.0.0.1', port: srv.port, secure: false, user: 'u', pass: 'falsch', from: 'a@b.example' }).send({ to: 'x@y.example', subject: 's', text: 't' }), /535/);
    await assert.rejects(new SmtpEmailProvider({ host: '127.0.0.1', port: bad.port, secure: false, from: 'a@b.example' }).send({ to: 'x@y.example', subject: 's', text: 't' }), /550/);
    const ok = new SmtpEmailProvider({ host: '127.0.0.1', port: srv.port, secure: false, from: 'a@b.example' });
    await assert.rejects(ok.send({ to: 'x@y.example\r\nBcc: spy@evil.example', subject: 's', text: 't' }), /Ungültige E-Mail/);
    await assert.rejects(ok.send({ to: 'x@y.example', subject: 'a\r\nBcc: spy@evil.example', text: 't' }), /Zeilenumbr/);
    assert.ok(!srv.log.some((l) => /evil/.test(l)));
  } finally { srv.close(); bad.close(); }
  // Verbindungsfehler → verständlicher Fehler statt Absturz
  await assert.rejects(new SmtpEmailProvider({ host: '127.0.0.1', port: 1, secure: false, from: 'a@b.example', timeoutMs: 500 }).send({ to: 'x@y.example', subject: 's', text: 't' }));
});

test('SMTP: MIME-Aufbau (Message-ID, keine versteckten Empfänger)', async () => {
  const mime = buildMime('a@b.example', { to: 'x@y.example', subject: 's', text: 't' }, 'id1');
  assert.match(mime, /Message-ID: <id1@b\.example>/); assert.doesNotMatch(mime, /Bcc/i);
});

test('Registry: E-Mail ist Mock ohne SMTP-Einstellungen, SMTP mit Host+Absender, „real“ ohne Daten bleibt Mock mit Grund', () => {
  const o = { baseUrl: 'http://x' };
  const st = (env: Record<string, string>) => createProviders(env, o).status.find((s) => s.kind === 'email')!;
  assert.equal(st({}).mode, 'mock');
  assert.equal(st({ APP_MODE: 'live' }).mode, 'mock'); assert.match(st({ APP_MODE: 'live' }).note, /SMTP_HOST/);
  const live = st({ APP_MODE: 'live', SMTP_HOST: 'smtp.example', SMTP_FROM: 'a@b.example' }); assert.equal(live.mode, 'real'); assert.equal(live.name, 'smtp');
});
