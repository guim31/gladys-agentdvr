# Agent DVR for Gladys Assistant

A [Gladys Assistant](https://gladysassistant.com) integration for
[Agent DVR](https://www.ispyconnect.com/), the video surveillance software of
iSpyConnect (free for local use). It brings each Agent DVR camera into Gladys as
a camera with its image, motion, recording and whether it is switched on, plus a
device for the server (armed, cameras recording), scene triggers, scene actions
and a dashboard widget. Everything goes through the local API of Agent DVR: no
iSpyConnect account, no cloud.

Tested against a real Agent DVR server in Docker (7.0) with simulated network
cameras, not yet on an installation in service with real cameras: feedback
welcome in the [issues](https://github.com/guim31/gladys-agentdvr/issues).

## Features

- **One Gladys camera per Agent DVR camera**: its image, sent at the chosen pace
  (10 s to 15 min) and at once on motion or an alert, scaled down by Agent DVR
  when it is too heavy for Gladys.
- **Motion** (`motion-sensor`, 1 = detected), read every 2 to 30 seconds.
- **Recording**: a switch that starts or stops a manual recording.
- **Camera on** (read only) and an **unreachable badge** on a camera switched on
  that sends no images.
- **An "Agent DVR" device**: **Armed** (read only) and **Cameras recording**.
- **Scene triggers**: "Agent DVR: motion detected", "Agent DVR: alert" (the
  alert message as a variable; raised by Agent DVR when armed) and "Agent DVR:
  camera offline", each with an optional camera filter.
- **Scene actions**: "Agent DVR: arm or disarm", "Agent DVR: record" (start or
  stop) and "Agent DVR: switch a camera on or off" (one camera or every camera).
- **Dashboard widget** "Agent DVR camera": image, motion, recording, armed
  state, and buttons to record, arm or disarm, switch the camera back on and
  bring a new image.
- **"Check the connection"** action: the version, the armed state, the cameras,
  whether they receive images and record.
- Texts and documentation in English, French, German and Spanish.

Disarming and switching a camera off are never a switch on the dashboard: they
go through a scene action or the widget, so a voice assistant cannot flip them
by mistake.

## Requirements

- Gladys 5.1.0 or later.
- Agent DVR reachable from Gladys on the local network, on its web port (8090
  by default).

## Installation

In Gladys: **Integrations → Install from GitHub**, address
`https://github.com/guim31/gladys-agentdvr`. Then enter the Agent DVR address in
the **Configuration** tab, and add the cameras and the server from the
**Discovery** tab. The user guide: [English](docs/en.md),
[français](docs/fr.md), [Deutsch](docs/de.md), [español](docs/es.md).

## How it works

- **API**: `command.cgi?cmd=getStatus` (armed, version), `getObjects` (the
  camera list, every minute: about 100 KB, mostly icons), `getObject&oid=N&ot=2`
  (the live state of each camera added in Gladys, every few seconds, under 1 KB),
  `alerts.json` (new alerts, by their growing id), `grab.jpg?oid=N[&size=WxH]`
  (images), `arm`/`disarm`, `record`/`recordStop`, `switchOn`/`switchOff`.
- An optional user name and password are sent as an HTTP Basic header.
- Agent DVR answers a command at once but applies some of them a moment later:
  the integration reads the camera again until the change shows.
- Nothing is stored under `/data`. Devices are published with
  `should_poll: false`: the container runs its own timers.

## Checked, and what was not

- In Docker, against `doitandbedone/ispyagentdvr` (Agent DVR 7.0.0.0), with
  network cameras served by `ffmpeg` (moving test pattern, still colour bars,
  and one unreachable), the integration running in its own image under the
  Gladys sandbox limits (`--cap-drop ALL`, read-only, 256 MB): discovery,
  states, images, motion trigger, alert trigger (from `command/alert`), camera
  offline (stream paused), record start and stop, switch off and on, arm and
  disarm, widget, "Check the connection", wrong address, wrong port. The test
  fixtures are answers recorded there, anonymised.
- Not checked: real cameras and long-running use, AI detection alerts, Agent DVR
  8.x (the API reference used is that of 8.1, the server tested is 7.0), and a
  login on the API (Agent DVR 7.0 did not ask for one on the local network, even
  with a local login set: the Basic header is sent when a user name is entered,
  but no Agent DVR was seen asking for it).

## Limits

- No live video: Gladys shows images (12 a minute per camera at most).
- Motion is read every few seconds: a very short motion may go unseen. Alerts
  are all read.
- Microphones, PTZ, profiles and past recordings are not covered.
- One Agent DVR server per integration.

## Development

```bash
npm ci
npm test
npm run lint
npm run format:check
npx github:GladysAssistant/integration-store .
```

See [CLAUDE.md](CLAUDE.md) for the architecture and the rules of the code.

## Credits

- The [agent-py](https://github.com/ispysoftware/agent-py) library (Apache 2.0,
  by iSpyConnect), behind the Home Assistant `agent_dvr` integration, for the API
  calls and the meaning of the camera states.
- The [Agent DVR API reference](https://ispysoftware.github.io/Agent_API/).

This integration is not affiliated with iSpyConnect nor Agent DVR. Agent DVR is
a trademark of its owners.

## License

[Apache 2.0](LICENSE)
