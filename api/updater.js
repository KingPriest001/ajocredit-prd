// Web-bundle updates (Capacitor Updater).
//
// The updater plugin POSTs to the update endpoint with a JSON body
// ({ device_id, version_name, platform, app_id, ... }) and expects
// { version, url, checksum } back:
//
//   * `checksum` is the SHA-256 of the bundle zip. Without it the plugin
//     refuses to download ("Checksum required").
//   * `version` is the bundle version. When it equals the version the device
//     is already running, the plugin does nothing - that is how we say
//     "there is no update for you".
//   * `url` must always be present and valid, even when there is nothing to
//     install, otherwise the plugin rejects the whole response.
//
// The API decides WHO gets the update (staged rollout) and can force every
// device back to the last known good bundle (rollback).

const crypto = require('crypto');

// The manifest URL and the rollout switches live in the environment.
// The rollout starts at 5% - a new web bundle goes out to a small slice of
// devices first and is widened only after it has been seen to work.
function manifestUrl(env) {
  return (env && env.APP_BUNDLE_MANIFEST) || 'https://kingpriest001.github.io/ajocredit-prd/bundle.json';
}
function rolloutPct(env) {
  const raw = parseInt(((env && env.APP_UPDATE_ROLLOUT) || '5'), 10);
  if (!Number.isFinite(raw)) return 5;
  return Math.max(0, Math.min(100, raw));
}
function rollbackOn(env) {
  return String((env && env.APP_UPDATE_ROLLBACK) || '0') === '1';
}

// A stable bucket per device: the same phone always lands in the same slot,
// so nobody flip-flops between "has update" and "no update" on every launch.
function deviceBucket(deviceId) {
  return crypto.createHash('sha256').update(String(deviceId || 'anonymous')).digest()[0] % 100;
}

// Which bundle are we pointing this device at?
function pickTarget(manifest, env) {
  if (!manifest || !manifest.version || !manifest.url) return null;
  if (rollbackOn(env)) {
    const rb = manifest.rollback || {};
    if (rb.version && rb.url) return { version: rb.version, url: rb.url, checksum: rb.sha256 || '' };
    // Nothing to roll back to. Returning null here leaves every device where it
    // is - serving the new bundle instead would be a rollback that does nothing.
    return null;
  }
  return { version: manifest.version, url: manifest.url, checksum: manifest.sha256 || '' };
}

// The decision, as a pure function so it can be tested without a server.
// Returns null when there is nothing to say (no manifest published yet).
function decide(manifest, env, deviceId, currentVersion) {
  const current = String(currentVersion || '').trim();
  if (rollbackOn(env)) {
    const target = pickTarget(manifest, env);
    // No rollback bundle published yet - nobody moves.
    if (!target) return { upToDate: true, version: current || '', url: '', checksum: '' };
    // The device already runs the good bundle.
    if (current && current === target.version) {
      return { upToDate: true, version: current, url: target.url, checksum: target.checksum };
    }
    // A rollback is for everybody, not a staged slice.
    return { upToDate: false, version: target.version, url: target.url, checksum: target.checksum };
  }
  const target = pickTarget(manifest, env);
  if (!target) return null;
  // The device already runs the bundle we are pointing at.
  if (current && current === target.version) {
    return { upToDate: true, version: current, url: target.url, checksum: target.checksum };
  }
  // Staged rollout: a stable bucket per device, so a phone does not flip between
  // "has update" and "no update" on every launch.
  const rollout = rolloutPct(env);
  if (rollout < 100 && deviceBucket(deviceId) >= rollout) {
    return { upToDate: true, version: current || target.version, url: target.url, checksum: target.checksum };
  }
  return { upToDate: false, version: target.version, url: target.url, checksum: target.checksum };
}

// Fetch the published manifest (cached for two minutes).
async function fetchManifest(url, cache) {
  if (cache && cache.data && Date.now() - cache.at < 120000) return cache.data;
  try {
    const r = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), {
      cache: 'no-store', signal: AbortSignal.timeout(15000)
    });
    const j = await r.json();
    if (j && j.version && j.url) { if (cache) { cache.at = Date.now(); cache.data = j; } return j; }
    return j;
  } catch (e) {
    return (cache && cache.data) || null;
  }
}

// The checksum normally ships inside the manifest. If it is missing we work it
// out from the bundle itself (once, then cached) - the plugin will not install
// a bundle whose checksum it cannot verify.
async function resolveChecksum(url, known, cache) {
  if (known) return String(known);
  if (!url) return '';
  if (cache && cache.key === url && Date.now() - cache.at < 600000) return cache.value;
  try {
    const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(60000) });
    if (!r.ok) return '';
    const buf = Buffer.from(await r.arrayBuffer());
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (cache) { cache.at = Date.now(); cache.key = url; cache.value = sha; }
    return sha;
  } catch (e) { return ''; }
}

module.exports = { manifestUrl, rolloutPct, rollbackOn, deviceBucket, pickTarget, decide, fetchManifest, resolveChecksum };
