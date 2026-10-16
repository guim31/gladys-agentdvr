// The `camera` widget: content inside the core's vocabulary and budget, the
// image served, the record, arm and refresh buttons.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent, validateWidgetImage } from '@gladysassistant/integration-sdk';
import { ACTIONS } from '../src/widgets.js';
import { createAll, createWorld } from './helpers/world.js';

const get = (world, camera, language = 'en') =>
  world.fake.widgetGet('camera', { settings: { camera }, language });
const cameraId = (world, name) =>
  world.fake.discoveredDevices.find((device) => device.name === name).external_id;
const press = (world, name, key) =>
  world.fake.widgetAction('camera', key, {}, { settings: { camera: cameraId(world, name) } });

test('the widget shows the image, motion, recording, armed and three buttons', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  for (const language of ['en', 'fr', 'de', 'es']) {
    const ack = await get(world, cameraId(world, 'Front door'), language);
    assert.equal(ack.success, true, ack.error);
    const { content } = ack.data;
    assert.deepEqual(validateWidgetContent(content), [], language);
    assert.deepEqual(
      content.components.map((component) => component.type),
      ['text', 'image', 'status', 'button', 'button', 'button'],
    );
    assert.deepEqual(
      content.components.slice(3).map((button) => button.action.key),
      [ACTIONS.STOP, ACTIONS.DISARM, ACTIONS.REFRESH],
    );
    if (language === 'fr') {
      assert.deepEqual(
        content.components[2].items.map((item) => item.value),
        ['Détecté', 'Oui', 'Oui'],
      );
      assert.equal(content.components[3].label, 'Arrêter l’enregistrement');
    }
    const image = await world.fake.widgetGetImage(content.components[1].key);
    assert.equal(image.success, true, image.error);
    assert.deepEqual(validateWidgetImage(image.data.image), []);
  }
});

test('the buttons record, disarm, switch a camera back on, bring a new image', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  let ack = await press(world, 'Porch', ACTIONS.RECORD);
  assert.equal(ack.success, true, ack.error);
  assert.match(ack.data.message.fr, /Enregistrement démarré/);
  assert.equal(world.server.get(3).data.recording, true);
  ack = await press(world, 'Porch', ACTIONS.DISARM);
  assert.match(ack.data.message.de, /unscharf/);
  assert.equal(world.server.status.armed, false);
  ack = await press(world, 'Porch', ACTIONS.REFRESH);
  assert.equal(ack.success, true, ack.error);

  world.server.get(2).data.online = false;
  await world.hub.pollAll();
  const content = (await get(world, cameraId(world, 'Garage'))).data.content;
  assert.deepEqual(
    content.components.filter((c) => c.type === 'button').map((button) => button.action.key),
    [ACTIONS.SWITCH_ON, ACTIONS.ARM, ACTIONS.REFRESH],
  );
  ack = await press(world, 'Garage', ACTIONS.RECORD);
  assert.match(ack.data.message.en, /switched off in Agent DVR/);
  ack = await press(world, 'Garage', ACTIONS.SWITCH_ON);
  assert.match(ack.data.message.es, /Cámara activada/);
  assert.equal(world.server.get(2).data.online, true);
});

test('without a camera, or with one Agent DVR no longer has: a sentence', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  let ack = await world.fake.widgetGet('camera', { settings: {}, language: 'de' });
  assert.match(ack.data.content.components[0].text, /Wähle/);
  ack = await get(world, 'ext:x:camera:9');
  assert.match(ack.data.content.components[0].text, /no longer in Agent DVR/);
});
