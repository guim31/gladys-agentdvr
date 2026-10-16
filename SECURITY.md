# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes.

The integration stores nothing under `/data`. The Agent DVR user name and
password, when set, are kept by Gladys in the integration configuration; the
container holds them in memory only, sends them as an HTTP Basic header to the
Agent DVR address of the configuration, and never writes them in a log line or
a message. Over plain HTTP they travel in clear text: put Agent DVR behind HTTPS
if the network between Gladys and Agent DVR is not trusted. Note that Agent DVR
itself may answer its local API without any login on the local network. The
integration only talks to that address, on the local network, and opens no
port.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
and Agent DVR and the cameras it records.
