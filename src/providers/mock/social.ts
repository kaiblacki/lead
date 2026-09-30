import type { SocialDataProvider, SocialProfile, SocialResult } from '../types.ts';
import { getWorld } from '../../fixtures/world.ts';
import { hostOf, norm, socialPlatformOf } from '../../core/text.ts';

export class MockSocialDataProvider implements SocialDataProvider {
  readonly name = 'mock-social'; readonly isMock = true;
  private now: () => Date;
  constructor(opts: { now?: () => Date } = {}) { this.now = opts.now ?? (() => new Date()); }

  async lookup(q: { name: string; city?: string; website?: string; knownUrls?: string[] }): Promise<SocialResult> {
    const now = this.now();
    const capturedAt = now.toISOString();
    const host = q.website ? hostOf(q.website) : null;
    const b = getWorld().find((x) => (host && x.domain?.replace(/^www\./, '') === host) || (norm(x.name) === norm(q.name) && (!q.city || norm(x.city) === norm(q.city))));
    const profiles: SocialProfile[] = [];
    if (b) {
      for (const [platform, s] of [['instagram', b.instagram], ['facebook', b.facebook]] as const) {
        if (!s) continue;
        profiles.push({ platform, url: `https://www.${platform}.com/${s.handle}`, handle: s.handle, followers: s.followers,
          lastPostAt: new Date(now.getTime() - s.lastPostDaysAgo * 86400000).toISOString(), source: this.name, capturedAt, quality: 'medium' });
      }
      return { profiles, complete: !b.socialUnverifiable, source: this.name, capturedAt };
    }
    // Unbekannter Betrieb (z. B. CSV-Import): nur bekannte Links, keine Aktivitätsdaten, nicht vollständig.
    for (const u of q.knownUrls ?? []) {
      const platform = socialPlatformOf(u);
      if (platform === 'instagram' || platform === 'facebook' || platform === 'linkedin' || platform === 'tiktok') profiles.push({ platform, url: u, source: 'lead-data', capturedAt, quality: 'low' });
    }
    return { profiles, complete: false, source: this.name, capturedAt };
  }
}
