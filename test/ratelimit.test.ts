import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/dashboard/ratelimit.ts';

test('RateLimiter: Limit, Fenster, getrennte Schlüssel, Reset', () => {
  const r = new RateLimiter(3, 1000);
  assert.ok(r.hit('a', 0) && r.hit('a', 1) && r.hit('a', 2));
  assert.equal(r.hit('a', 3), false);
  assert.equal(r.blocked('a', 4), true);
  assert.equal(r.hit('b', 4), true);
  assert.equal(r.hit('a', 1001), true);          // neues Fenster
  r.reset('a'); assert.equal(r.blocked('a', 1002), false);
});
