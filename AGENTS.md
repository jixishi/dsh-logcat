# AGENTS.md — dsh-logcat

Instructions for any agent working in this repository. Keep this file in sync with the
release tooling; it must never contain secret values.

## Release & credentials

- Credentials come from the environment (the portable DSH launcher injects them). **Never ask the
  user for tokens and never commit them.**
- The secrets file (`<portable>\data\portable-secrets.env`) is part of the portable tree and
  travels with it. Copy the **whole folder**, not just `data\dsh-home`; never hard-code a drive
  letter — the launcher resolves by its own location.
- Publish with plain npm commands (there are no in-repo publish scripts):
  - `npm publish --registry=https://registry.npmjs.org` → npmjs.org (`latest`, primary channel;
    needs `$env:NPM_TOKEN`, a bypass-2FA automation token)
  - `npm publish --registry=https://npm.pkg.github.com --tag latest` → GitHub Packages (mirror;
    needs `$env:NODE_AUTH_TOKEN` with `write:packages`)
- GitHub is unreachable directly from this machine: use the local proxy
  (`git -c http.proxy=http://127.0.0.1:3067 push ...`, `curl -x http://127.0.0.1:3067 ...`).
  The port in this file used to say `7890`, which is not listening on this host.
- One GitHub Release + tag per stable version, always with the **full 40-char SHA** (short SHAs
  are rejected with 422). npm may report "being processed" for a few minutes after publish.
- Bump versions by editing `package.json` as text — PowerShell JSON writes add a BOM that breaks
  the client bundle loader.

## Verification gates (run before every publish)

```sh
node --check lib/index.js lib/client.js
node --import ./.tmp/register-stub.mjs selfcheck.mjs   # 30 host tools registered
```

`@deepseek-ai/dsh-tools` lives inside the host's `app.asar`, which a bare Node process cannot
read, so a plain `node selfcheck.mjs` fails to import. Always run it through the local stub
loader in `.tmp/` (a verification aid only — never shipped).

## Host dependencies (linked installs)

- Any `@deepseek-ai/*` package the host half imports **must** be declared in `package.json`
  `peerDependencies`, with a range matching the host's major line (currently `0.2.1-rc.5`).
  For `link:` installs DSH only applies peer interception when the importer's own manifest
  lists the name; otherwise the import dies with `ERR_MODULE_NOT_FOUND` and the whole plugin
  (both halves) fails to activate. This is why `@deepseek-ai/dsh-tools` is a peer here.
- `ws` / `react` / `react-dom` stay real installs under this directory's `node_modules`.
- After changing the manifest, re-enable the plugin row (`plugin_manager` `set_plugin`) or
  restart the host — an already-failed import is not retried by itself.

## UI

- The **right-hand drawer is the default surface**; the native `main` + `sidebar.panellist`
  panel is opt-in via `window.__DSH_LOGCAT_NATIVE_PANEL__ = true`.
- Design language: host tokens first (`--dsw-*`), one accent colour, bundled SVG icons
  (no emoji), monospace + tabular-nums log rows, dense but calm chrome.
- Keep the drawer overlay-based: it must not push the conversation layout.
