# MathNotes Headless Deployment Bundle

This directory contains templates only. Generating the bundle does not install a service, modify networking, expose a port, or configure Tailscale.

## Bundle layout

- `bin/mathnotes-network-node.cjs`: bundled Node.js entry point.
- `config/network-node-v2.example.json`: safe configuration example containing environment variable names, not secrets.
- `service/systemd/`: Linux systemd template.
- `service/launchd/`: macOS launchd template.
- `service/windows/`: WinSW service template. The WinSW executable is intentionally not bundled.
- `service/windows/MathNotesHost.ps1.template`: Windows host control template with a host-only `pair` action.
- `artifact-manifest.json`: sorted SHA-256 inventory of every payload file except the manifest itself.

## Before installation

1. Install a supported Node.js runtime (22.13+ or 24+).
2. Copy the example config outside the application directory and replace its generic runtime paths.
3. Provide `MATHNOTES_HEADLESS_TOKEN` and `MATHNOTES_HEADLESS_URL` through the host's secret/environment mechanism. Do not write their values into the JSON or service template.
4. Replace every `@@...@@` placeholder in the selected service template.
5. Run the bounded preflight before registering any service:

   ```text
   node bin/mathnotes-network-node.cjs --config <absolute-config-path> --check
   ```

6. After installation, verify the process and status file:

   ```text
   node bin/mathnotes-network-node.cjs --config <absolute-config-path> --status
   ```

7. On Windows, replace the four `@@...@@` paths in `MathNotesHost.ps1.template`. After the
   host starts, create a short-lived pairing code without revealing the long-lived host token:

   ```powershell
   .\MathNotesHost.ps1 pair
   ```

Tailscale Serve consent, HTTPS, Grants, WinSW signature verification, service registration, startup recovery, sleep/wake, log rotation, and uninstall are separate manual acceptance gates.

## Platform notes

- systemd sends stdout and stderr to the journal and restarts only after failure.
- launchd uses explicit `ProgramArguments`, `KeepAlive` on unsuccessful exit, and separate log files.
- WinSW uses rolling files. Download and verify an official WinSW release separately, place the executable beside the final XML, and keep the base names identical.
