import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import type { HostingProvider, SiteFiles } from '../types.ts';
import type { HostedSites } from './crawler.ts';
import { slugify } from '../../core/text.ts';

/**
 * Hosting-Ersatz: schreibt die Seite in einen lokalen Ordner. Das Dashboard liefert sie unter /hosted/<slug>/ aus,
 * sodass die „veröffentlichte" Seite lokal im Browser ansehbar und prüfbar ist. Ausfälle lassen sich simulieren.
 */
export class MockHostingProvider implements HostingProvider, HostedSites {
  readonly name = 'mock-hosting'; readonly isMock = true;
  readonly baseUrl: string; private root: string;
  constructor(baseUrl: string, root = 'out/mock-hosting') { this.baseUrl = baseUrl.replace(/\/$/, ''); this.root = resolve(root); }
  private dir(slug: string) { return join(this.root, slugify(slug)); }
  async deploy(slug: string, files: SiteFiles) {
    const dir = this.dir(slug);
    rmSync(dir, { recursive: true, force: true });
    for (const [name, body] of Object.entries(files)) {
      const target = resolve(dir, name);
      if (!target.startsWith(dir + '/')) throw new Error('Ungültiger Dateiname');
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body);
    }
    return { url: `${this.baseUrl}/hosted/${slugify(slug)}/` };
  }
  async exists(slug: string) { return existsSync(join(this.dir(slug), 'index.html')); }
  read(slug: string, path: string): string | null {
    const dir = this.dir(slug);
    const target = resolve(dir, path || 'index.html');
    if (!target.startsWith(dir + '/') || !existsSync(target)) return null;
    return readFileSync(target, 'utf8');
  }
  /** Mock-only: Ausfall der „veröffentlichten" Seite simulieren (für Wartungstests). */
  setDown(slug: string, down: boolean) {
    const marker = join(this.dir(slug), '.down');
    if (down) writeFileSync(marker, '1'); else rmSync(marker, { force: true });
  }
  isDown(slug: string) { return existsSync(join(this.dir(slug), '.down')); }
}
