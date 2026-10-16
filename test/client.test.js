// The Agent DVR client on the answers recorded from a real server: address
// parsing, cameras, alerts, errors in a 200, credentials never in the address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentClient,
  normalizeAlert,
  normalizeCamera,
  parseServerUrl,
} from '../src/agent/client.js';
import { FakeAgent, RECORDED } from './helpers/fakeAgent.js';

test('addresses: port 8090 when none is typed; https keeps its own; no credentials', () => {
  assert.deepEqual(parseServerUrl('192.0.2.10'), {
    origin: 'http://192.0.2.10:8090',
    basePath: '',
  });
  assert.deepEqual(parseServerUrl('nvr.lan:9000/'), {
    origin: 'http://nvr.lan:9000',
    basePath: '',
  });
  assert.deepEqual(parseServerUrl('https://agent.example/dvr/'), {
    origin: 'https://agent.example',
    basePath: '/dvr',
  });
  assert.deepEqual(parseServerUrl('http://nvr.lan'), { origin: 'http://nvr.lan', basePath: '' });
  assert.equal(parseServerUrl('http://admin:pw@nvr.lan'), null);
  assert.equal(parseServerUrl('ftp://nvr.lan'), null);
  assert.equal(parseServerUrl(''), null);
});

test('the recorded cameras: switched on, frames, motion, recording', () => {
  const cameras = RECORDED.getObjects.objectList.map(normalizeCamera);
  assert.deepEqual(
    cameras.map((c) => [c.id, c.name, c.enabled, c.connected, c.motion, c.recording]),
    [
      [1, 'Front door', true, true, true, true],
      [2, 'Garage', true, false, false, false],
      [3, 'Porch', true, true, false, false],
    ],
  );
  assert.deepEqual(normalizeAlert(RECORDED.alerts.alerts[0]), {
    id: 5,
    cameraId: 1,
    type: 2,
    reason: 'alert',
    message: 'Alert',
  });
});

test('the client reads status, cameras and alerts; errors in a 200 are errors', async () => {
  const server = new FakeAgent();
  const client = new AgentClient({ url: '192.0.2.10', fetch: server.fetch });
  assert.deepEqual(await client.status(), {
    armed: true,
    recording: 1,
    version: '7.0.0.0',
    name: 'agent-server',
  });
  assert.equal((await client.listCameras()).length, 3);
  assert.equal((await client.camera(3)).name, 'Porch');
  await assert.rejects(client.camera(9), { kind: 'notFound', message: /Device not found/ });
  assert.deepEqual(
    (await client.alerts()).map((alert) => alert.id),
    [5, 4, 3, 2, 1],
  );
  assert.ok((await client.image(1)).length > 1000);
  await assert.rejects(client.image(9), { kind: 'http' });
  server.down = true;
  await assert.rejects(client.status(), { kind: 'network' });
});

test('credentials go in a Basic header, never in the address; a refusal is auth', async () => {
  const server = new FakeAgent({ auth: 'gladys:s3cret' });
  const good = new AgentClient({
    url: '192.0.2.10',
    username: 'gladys',
    password: 's3cret',
    fetch: server.fetch,
  });
  assert.equal((await good.status()).armed, true);
  assert.ok(server.requests.every((request) => !request.includes('s3cret')));
  const bad = new AgentClient({
    url: '192.0.2.10',
    username: 'gladys',
    password: 'nope',
    fetch: server.fetch,
  });
  await assert.rejects(bad.status(), (err) => err.kind === 'auth' && !/nope/.test(err.message));
  assert.doesNotMatch(good.label, /gladys/);
});

test('something that is not Agent DVR is said so', async () => {
  const client = new AgentClient({
    url: '192.0.2.10',
    fetch: async () => new Response('<html></html>', { status: 200 }),
  });
  await assert.rejects(client.status(), { kind: 'http', message: /JSON/ });
  const other = new AgentClient({
    url: '192.0.2.10',
    fetch: async () => Response.json({ hello: 1 }),
  });
  await assert.rejects(other.status(), /does not answer like Agent DVR/);
});
