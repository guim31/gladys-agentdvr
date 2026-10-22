# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Fixed

- Gladys 5.2 refused the camera images after a camera was switched off in
  Agent DVR: the **Camera on** feature was published as `camera/enabled`, which
  Gladys 5.2 uses as the privacy mode of the camera. It is now a read-only
  `input/binary` feature (On/Off) with a new key. For the cameras added with
  1.0.x, click **Update** in the Discovery tab of the integration to swap the
  feature; until then, the old one is set to 1 once at startup and never
  written again.

## [1.0.0] - 2026-10-16

### Added

- Agent DVR servers (iSpyConnect), reached through their local API at the
  address of the configuration (port 8090 by default), with an optional login.
- One Gladys camera per Agent DVR camera: its image, sent at the chosen pace and
  at once on motion or an alert, scaled down by Agent DVR when too heavy for
  Gladys; "Motion"; "Recording", a switch that starts or stops a recording;
  "Camera on" (read only).
- An "Agent DVR" device for the server: "Armed" (read only) and "Cameras
  recording".
- Cameras that send no images show as unreachable in Gladys.
- Scene triggers "Agent DVR: motion detected", "Agent DVR: alert" (with its
  message) and "Agent DVR: camera offline"; scene actions "Agent DVR: arm or
  disarm", "Agent DVR: record" and "Agent DVR: switch a camera on or off" (one
  camera or all of them); dashboard widget "Agent DVR camera"; action "Check
  the connection".
- Texts and documentation in English, French, German and Spanish.

[Unreleased]: https://github.com/guim31/gladys-agentdvr/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/guim31/gladys-agentdvr/releases/tag/v1.0.0
