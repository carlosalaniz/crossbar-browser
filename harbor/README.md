# Crossbar on Harbor

Install from this repository as a git source:

```sh
harbor sources add https://github.com/carlosalaniz/crossbar-browser
```

After it starts, open the app and enter the setup code from the app's logs.

## How it differs from `deploy/compose.yaml`

Harbor packages can't declare an internal-only network or a seccomp profile, so:

- **Egress.** The browser container can't be put on an internal network. It firewalls itself instead (`net-admin` permission): its only way out is the egress proxy. Then it drops root and every capability before Chromium starts. If the rules can't be installed, it doesn't start.
- **Chromium's sandbox.** Docker's default seccomp profile blocks the namespaces Chromium's sandbox needs, and Harbor can't relax it yet. With the **Chromium sandbox** setting on (the default), the browser won't start on Harbor. Turning it off is your call. The trade-off is in the setting's help and in `docs/threat-model.md`. The fix is a Harbor permission that renders `deploy/browser/seccomp.json` (Docker's default profile plus `clone`, `unshare`, `setns` and `chroot`).
