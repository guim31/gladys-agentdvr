// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
// -----------------------------------------------------------------------------

import { parseServerUrl } from './agent/client.js';

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

// Seconds between two readings of the cameras added in Gladys
// (`poll_interval`): motion, recording, the armed state and new alerts.
export const POLL_INTERVALS = [2, 5, 10, 30];

// Seconds between two images sent to Gladys (`snapshot_interval`). The core
// accepts 12 images a minute per camera; motion or an alert also sends one at once.
export const SNAPSHOT_INTERVALS = [10, 30, 60, 300, 900];

export const DEFAULT_CONFIG = {
  url: '',
  username: '',
  poll_interval: '5',
  snapshot_interval: '60',
  language: 'fr',
};

function pick(value, allowed, fallback) {
  const number = Number(value);
  return allowed.includes(number) ? number : Number(fallback);
}

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const url = String(source.url ?? DEFAULT_CONFIG.url).trim();
  return {
    url,
    validUrl: Boolean(parseServerUrl(url)),
    // Empty: an Agent DVR that asks for no login (the usual case on a LAN).
    username: String(source.username ?? DEFAULT_CONFIG.username).trim(),
    password: typeof source.password === 'string' ? source.password : '',
    pollSeconds: pick(source.poll_interval, POLL_INTERVALS, DEFAULT_CONFIG.poll_interval),
    snapshotSeconds: pick(
      source.snapshot_interval,
      SNAPSHOT_INTERVALS,
      DEFAULT_CONFIG.snapshot_interval,
    ),
    language: LANGUAGES.includes(source.language) ? source.language : DEFAULT_CONFIG.language,
  };
}

/** What identifies a connection: a change of one of them means a new client. */
export const connectionKey = (config) =>
  JSON.stringify([config.url, config.username, config.password]);
