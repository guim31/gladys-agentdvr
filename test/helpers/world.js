// -----------------------------------------------------------------------------
// A complete test world: the SDK's fake Gladys and a simulated Agent DVR
// (test/helpers/fakeAgent.js), with the integration wired on top through
// registerHandlers. No periodic timer runs: the tests call the hub's cycles.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';
import { FakeAgent } from './fakeAgent.js';

// The integration logs every change; keep the test output readable.
process.env.LOG_LEVEL ??= 'silent';

export const DEFAULT_CONFIG = { url: '192.0.2.10', language: 'en' };

export const FAST = {
  minImageSpacingMs: 0,
  offlineAfterMs: 0,
  restartGraceMs: 0,
  settleMs: 0,
};

/**
 * @param {object} [options]
 * @param {FakeAgent} [options.server]
 * @param {object} [options.config] raw integration config
 * @param {Array} [options.created] devices already created in Gladys
 */
export async function createWorld({
  server = new FakeAgent(),
  config = DEFAULT_CONFIG,
  created = [],
  connect = true,
  timings = FAST,
} = {}) {
  const gladys = createFakeGladys({ config, devices: created });
  const app = registerHandlers(gladys, { fetch: server.fetch, timers: false, timings });
  if (connect) {
    await gladys.connect();
    await app.ready;
    await app.hub.idle();
  }
  return { gladys, fake: gladys.fake, server, app, hub: app.hub };
}

/** Add every discovered device in Gladys, as the user would. */
export async function createAll(world) {
  for (const device of world.fake.discoveredDevices) {
    await world.fake.deviceCreated(device);
  }
  await world.hub.idle();
}

export { FakeAgent };
