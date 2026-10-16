// -----------------------------------------------------------------------------
// Scene actions (manifest `scene_actions`, Gladys 5.1+).
//
// What they add to "Control a device": arming or disarming Agent DVR (the
// "leaving home" scene), switching EVERY camera on or off at once (privacy
// at home, surveillance when away), and a manual recording started or
// stopped on one camera (e.g. when a door opens). The armed state and the
// "camera on" feature are read only on purpose: these are deliberate
// choices, never a toggle a voice assistant flips.
// -----------------------------------------------------------------------------

export const ARM_COMMANDS = { arm: true, disarm: false };
export const RECORD_COMMANDS = { start: true, stop: false };
export const SWITCH_COMMANDS = { on: true, off: false };

function commandOf(table, fields) {
  const on = table[fields?.command];
  if (on === undefined) {
    throw new Error(`Unknown command "${fields?.command}": ${Object.keys(table).join(' or ')}`);
  }
  return on;
}

async function setArmed(hub, { fields }) {
  await hub.setArmed(commandOf(ARM_COMMANDS, fields));
}

async function record(hub, { fields }) {
  const on = commandOf(RECORD_COMMANDS, fields);
  if (!fields?.camera) {
    throw new Error('Choose a camera');
  }
  await hub.setRecording(hub.require(fields.camera), on);
}

async function switchCamera(hub, { fields }) {
  const on = commandOf(SWITCH_COMMANDS, fields);
  // "Every camera": those added in Gladys; a camera left out of Gladys is not
  // the user's to change here.
  const cameras = fields?.camera ? [hub.require(fields.camera)] : hub.createdCameras();
  if (cameras.length === 0) {
    throw new Error('No Agent DVR camera added in Gladys');
  }
  return { cameras: await hub.setEnabled(cameras, on) };
}

export const SCENE_ACTIONS = {
  set_armed: setArmed,
  record,
  switch_camera: switchCamera,
};
