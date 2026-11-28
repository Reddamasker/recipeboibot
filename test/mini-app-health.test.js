import test from 'node:test';
import assert from 'node:assert/strict';
import {createMiniAppHealth, isIphoneWebView} from '../src/mini-app-health.js';

test('iPhone launch monitoring waits for rendering and expires old observations', () => {
  const health = createMiniAppHealth();
  health.observe('opened', 0);
  assert.equal(health.stalled(120000), false);
  health.observe('opened', 120000);
  assert.equal(health.stalled(180000), false);
  assert.equal(health.stalled(240000), true);
  health.observe('rendered', 240000);
  assert.equal(health.stalled(240000), false);
  assert.equal(health.stalled(900000), false);
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
  assert.ok(isIphoneWebView({method:'GET', headers:{'user-agent':ua}}));
  assert.ok(!isIphoneWebView({method:'HEAD', headers:{'user-agent':ua}}));
  assert.ok(!isIphoneWebView({method:'GET', headers:{'user-agent':ua + ' Safari/604.1'}}));
});
