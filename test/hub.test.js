// The integration end to end, against the SDK's fake Gladys and a simulated
// Agent DVR (answers recorded from 7.0.0.0): discovery, states, images,
// triggers, recording, arming, cameras switched on and off, scene actions,
// the manifest action.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRIGGERS } from '../src/hub.js';
import { DEFAULT_CONFIG, FakeAgent, createAll, createWorld } from './helpers/world.js';

function idOf(world, camera, feature) {
  const ids = world.hub.ids({ id: camera });
  return feature ? ids.feature(feature) : ids.device;
}

const lastState = (world, camera, feature) => world.fake.lastState(idOf(world, camera, feature));
const serverState = (world, feature) => world.fake.lastState(world.hub.serverIds.feature(feature));
const events = (world, key) => world.fake.sceneEvents.filter((event) => event.key === key);

test('one device per camera and one for the server, without the Gladys scheduler', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  assert.deepEqual(
    world.fake.discoveredDevices.map((device) => [device.name, device.should_poll]),
    [
      ['Agent DVR', false],
      ['Front door', false],
      ['Garage', false],
      ['Porch', false],
    ],
  );
  assert.deepEqual(world.fake.connectionStatus, { connected: true });
});

test('adding the devices publishes motion, recording, camera on, armed, images', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  assert.equal(lastState(world, 1, 'motion'), 1);
  assert.equal(lastState(world, 1, 'recording'), 1);
  assert.equal(lastState(world, 1, 'enabled'), 1);
  assert.equal(lastState(world, 3, 'motion'), 0);
  assert.equal(serverState(world, 'armed'), 1);
  assert.equal(serverState(world, 'recording-count'), 1);
  const transports = Object.fromEntries(
    world.fake.transports.map((entry) => [entry.device_external_id, entry.transport]),
  );
  assert.equal(transports[idOf(world, 1)], 'local');
  // Garage: Agent DVR keeps trying to connect to its camera.
  assert.equal(transports[idOf(world, 2)], 'unreachable');
  assert.equal(transports[world.hub.serverIds.device], 'local');
  // The image goes with the DEVICE external id (the core answers 404 to a feature's).
  const images = new Set(world.fake.cameraImages.map((image) => image.device_external_id));
  assert.ok(images.has(idOf(world, 1)) && images.has(idOf(world, 3)));
  assert.match(world.fake.cameraImages[0].image, /^image\/jpg;base64,\/9j\//);
  assert.ok(world.fake.widgetRefreshes.includes('camera'));
});

test('the reading is done by the container: no onPoll needed', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  world.server.set(3, 'detected', true);
  await world.hub.pollAll();
  assert.equal(lastState(world, 3, 'motion'), 1);
  assert.ok(world.server.count('cmd=getObject') >= 3);
});

test('motion starting: the state, an image, the trigger once; and back to none', async (t) => {
  const world = await createWorld({ config: { ...DEFAULT_CONFIG, snapshot_interval: '900' } });
  t.after(() => world.app.stop());
  await createAll(world);
  await world.hub.pollAll();
  assert.deepEqual(events(world, TRIGGERS.MOTION), [], 'motion going on at start is not news');
  const before = world.fake.cameraImages.length;
  world.server.set(3, 'detected', true);
  await world.hub.pollAll();
  await world.hub.pollAll();
  await world.hub.idle();
  assert.equal(lastState(world, 3, 'motion'), 1);
  assert.equal(world.fake.cameraImages.length, before + 1);
  assert.deepEqual(events(world, TRIGGERS.MOTION), [
    { key: TRIGGERS.MOTION, data: { camera: idOf(world, 3), camera_name: 'Porch' } },
  ]);
  world.server.set(3, 'detected', false);
  await world.hub.pollAll();
  assert.equal(lastState(world, 3, 'motion'), 0);
  // The camera list, read every minute, does not swallow a motion start.
  world.server.set(3, 'detected', true);
  await world.hub.refresh();
  await world.hub.pollAll();
  await world.hub.idle();
  assert.equal(events(world, TRIGGERS.MOTION).length, 2);
});

test('a new alert fires the trigger with its message, once; old ones are not news', async (t) => {
  const world = await createWorld({ config: { ...DEFAULT_CONFIG, snapshot_interval: '900' } });
  t.after(() => world.app.stop());
  await createAll(world);
  await world.hub.pollAll();
  assert.deepEqual(events(world, TRIGGERS.ALERT), []);
  world.server.addAlert(3, 'Person detected');
  world.server.addAlert(9, 'A microphone');
  world.server.addAlert(1);
  const before = world.fake.cameraImages.length;
  await Promise.all([world.hub.pollAll(), world.hub.pollAll()]);
  await world.hub.pollAll();
  await world.hub.idle();
  assert.deepEqual(events(world, TRIGGERS.ALERT), [
    {
      key: TRIGGERS.ALERT,
      data: { camera: idOf(world, 3), camera_name: 'Porch', message: 'Person detected' },
    },
    {
      key: TRIGGERS.ALERT,
      data: { camera: idOf(world, 1), camera_name: 'Front door', message: 'Alert' },
    },
  ]);
  assert.equal(world.fake.cameraImages.length, before + 2);
});

test('Agent DVR restarted with its alerts cleared: the next alert still fires', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  await world.hub.pollAll();
  world.server.alerts = [];
  await world.hub.pollAll();
  world.server.addAlert(3);
  await world.hub.pollAll();
  await world.hub.idle();
  assert.equal(events(world, TRIGGERS.ALERT).length, 1);
});

test('a camera without frames goes offline once, then comes back', async (t) => {
  const world = await createWorld({ timings: { minImageSpacingMs: 0, offlineAfterMs: 60000 } });
  t.after(() => world.app.stop());
  await createAll(world);
  world.server.set(1, 'connected', false);
  await world.hub.pollAll();
  assert.deepEqual(events(world, TRIGGERS.OFFLINE), [], 'a blip is not enough');
  world.hub.cameras.get(1).offlineSince -= 61000;
  await world.hub.pollAll();
  await world.hub.pollAll();
  await world.hub.idle();
  assert.deepEqual(events(world, TRIGGERS.OFFLINE), [
    { key: TRIGGERS.OFFLINE, data: { camera: idOf(world, 1), camera_name: 'Front door' } },
  ]);
  assert.equal(world.fake.transports.at(-1).transport, 'unreachable');
  world.server.set(1, 'connected', true);
  await world.hub.pollAll();
  assert.equal(world.fake.transports.at(-1).transport, 'local');
});

test('the recording switch of the dashboard starts and stops a recording', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  const porch = world.fake.discoveredDevices.find((device) => device.name === 'Porch');
  const feature = porch.features.find((item) => item.external_id.endsWith(':recording'));
  let ack = await world.fake.setValue(porch, feature, 1);
  assert.equal(ack.success, true, ack.error);
  assert.equal(lastState(world, 3, 'recording'), 1);
  ack = await world.fake.setValue(porch, feature, 0);
  assert.equal(ack.success, true, ack.error);
  assert.equal(lastState(world, 3, 'recording'), 0);
  // The other features are read only.
  const enabled = porch.features.find((item) => item.external_id.endsWith(':enabled'));
  assert.equal((await world.fake.setValue(porch, enabled, 0)).success, false);
  assert.equal(world.server.get(3).data.online, true);
});

test('scene action: disarm then arm', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  let ack = await world.fake.sceneAction('set_armed', { command: 'disarm' });
  assert.equal(ack.success, true, ack.error);
  assert.equal(world.server.status.armed, false);
  assert.equal(serverState(world, 'armed'), 0);
  ack = await world.fake.sceneAction('set_armed', { command: 'arm' });
  assert.equal(ack.success, true, ack.error);
  assert.equal(serverState(world, 'armed'), 1);
  ack = await world.fake.sceneAction('set_armed', { command: 'maybe' });
  assert.equal(ack.success, false);
});

test('scene action: every camera off, then on; only those that change', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  world.server.get(2).data.online = false;
  await world.hub.refresh();
  let ack = await world.fake.sceneAction('switch_camera', { command: 'off' });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ack.data.outputs, { cameras: 2 });
  assert.equal(lastState(world, 1, 'enabled'), 0);
  assert.equal(lastState(world, 1, 'motion'), 0);
  // Switched off on purpose: no "Camera offline".
  assert.deepEqual(events(world, TRIGGERS.OFFLINE), []);
  ack = await world.fake.sceneAction('switch_camera', { camera: idOf(world, 1), command: 'on' });
  assert.deepEqual(ack.data.outputs, { cameras: 1 });
  assert.equal(lastState(world, 1, 'enabled'), 1);
});

test('Agent DVR applies a command a moment later: read again until it shows', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  world.server.lag = 3;
  let ack = await world.fake.sceneAction('switch_camera', {
    camera: idOf(world, 1),
    command: 'off',
  });
  assert.deepEqual(ack.data.outputs, { cameras: 1 });
  assert.equal(lastState(world, 1, 'enabled'), 0);
  // Switched on right after: sent, even if a stale reading said "on".
  ack = await world.fake.sceneAction('switch_camera', { camera: idOf(world, 1), command: 'on' });
  assert.equal(ack.success, true, ack.error);
  assert.equal(lastState(world, 1, 'enabled'), 1);
  assert.equal(world.server.get(1).data.online, true);
  ack = await world.fake.sceneAction('record', { camera: idOf(world, 1), command: 'stop' });
  assert.equal(ack.success, true, ack.error);
  assert.equal(lastState(world, 1, 'recording'), 0);
});

test('scene action: record on a camera; refused on a camera switched off', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  let ack = await world.fake.sceneAction('record', { camera: idOf(world, 3), command: 'start' });
  assert.equal(ack.success, true, ack.error);
  assert.equal(lastState(world, 3, 'recording'), 1);
  world.server.get(2).data.online = false;
  await world.hub.refresh();
  ack = await world.fake.sceneAction('record', { camera: idOf(world, 2), command: 'start' });
  assert.equal(ack.success, false);
  assert.match(ack.error, /switched off/);
  ack = await world.fake.sceneAction('record', { command: 'start' });
  assert.match(ack.error, /Choose a camera/);
});

test('a wrong password, a server down: the connection status', async (t) => {
  let world = await createWorld({
    server: new FakeAgent({ auth: 'gladys:s3cret' }),
    config: { ...DEFAULT_CONFIG, username: 'gladys', password: 'wrong' },
  });
  assert.equal(world.fake.connectionStatus.connected, false);
  assert.match(world.fake.connectionStatus.message.en, /refuses the user name or password/);
  await world.app.stop();

  world = await createWorld({
    server: new FakeAgent({ auth: 'gladys:s3cret' }),
    config: { ...DEFAULT_CONFIG, username: 'gladys', password: 's3cret' },
  });
  assert.deepEqual(world.fake.connectionStatus, { connected: true });
  await world.app.stop();

  world = await createWorld({ config: { url: '' } });
  assert.match(world.fake.connectionStatus.message.fr, /Saisissez l'adresse/);
  await world.app.stop();

  world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  world.server.down = true;
  await world.hub.pollAll();
  assert.deepEqual(events(world, TRIGGERS.OFFLINE), [], 'one lost reading is not an outage');
  await world.hub.refresh();
  await world.hub.idle();
  assert.match(world.fake.connectionStatus.message.en, /does not answer/);
  assert.deepEqual(
    events(world, TRIGGERS.OFFLINE).map((event) => event.data.camera_name),
    ['Front door', 'Porch'],
  );
  world.server.down = false;
  await world.hub.refresh();
  assert.deepEqual(world.fake.connectionStatus, { connected: true });
  assert.equal(world.fake.transports.at(-1).transport, 'local');
});

test('the "Check the connection" action lists the cameras', async (t) => {
  const world = await createWorld({ config: { ...DEFAULT_CONFIG, language: 'fr' } });
  t.after(() => world.app.stop());
  await createAll(world);
  const ack = await world.fake.action('check', {});
  assert.equal(ack.success, true, ack.error);
  assert.match(
    ack.data.message.fr,
    /Agent DVR 7\.0\.0\.0 répond à http:\/\/192\.0\.2\.10:8090 : 3 caméra\(s\)\. Système armé\./,
  );
  assert.match(ack.data.message.fr, /- Garage: pas d'images/);
  assert.match(ack.data.message.en, /- Front door: receives images, recording/);
});

test('a camera removed from Agent DVR leaves the discovery list', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  world.server.removeCamera(2);
  await world.hub.refresh();
  assert.deepEqual(
    world.fake.discoveredDevices.map((device) => device.name),
    ['Agent DVR', 'Front door', 'Porch'],
  );
});

test('a reconnection to Gladys sends every state again', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  const before = world.fake.states.length;
  await world.fake.reconnect?.();
  await world.app.hub.resync(world.hub.config);
  assert.ok(world.fake.states.length > before);
});
