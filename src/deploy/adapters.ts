import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import type { SiteFiles } from '../production/build.ts';

export interface Deployer {
  readonly name: string;
  deploy(slug: string, files: SiteFiles): Promise<{ url: string }>;
}

export const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'site';

/** Schreibt die Seite in einen Ordner (zum Prüfen, für eigenes Hosting oder manuellen Upload). */
export class FolderDeployer implements Deployer {
  readonly name = 'folder';
  private root: string;
  constructor(root = 'out/sites') { this.root = resolve(root); }
  async deploy(slug: string, files: SiteFiles) {
    const dir = join(this.root, slugify(slug));
    for (const [name, body] of Object.entries(files)) {
      const target = resolve(dir, name);
      if (!target.startsWith(dir + '/')) throw new Error('Ungültiger Dateiname');
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body);
    }
    return { url: `file://${dir}/index.html` };
  }
}

/** Vercel Deployments API v13. Nicht gegen das echte Vercel getestet – siehe README. */
export class VercelDeployer implements Deployer {
  readonly name = 'vercel';
  private token: string; private teamId?: string;
  constructor(token = process.env.VERCEL_TOKEN, teamId = process.env.VERCEL_TEAM_ID) {
    if (!token) throw new Error('VERCEL_TOKEN fehlt');
    this.token = token; this.teamId = teamId;
  }
  async deploy(slug: string, files: SiteFiles) {
    const q = this.teamId ? `?teamId=${encodeURIComponent(this.teamId)}` : '';
    const res = await fetch(`https://api.vercel.com/v13/deployments${q}`, {
      method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: slugify(slug), target: 'production', projectSettings: { framework: null },
        files: Object.entries(files).map(([file, data]) => ({ file, data, encoding: 'utf-8' })) }),
    });
    const d = (await res.json()) as { url?: string; error?: { message?: string } };
    if (!res.ok || !d.url) throw new Error(`Vercel: ${d.error?.message ?? res.status}`);
    return { url: `https://${d.url}` };
  }
}
