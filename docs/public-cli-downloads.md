# Public Sidestream CLI download

The standalone CLI is delivered separately from the Adobe installers. The current archive supports macOS Apple silicon and Intel, and requires an existing Node.js 18+ installation. It contains the shared download engine and Mac helper binaries; it does not require Premiere or a source checkout.

Public entrypoints:

- `https://downloads.sidestream.tv/cli/latest` redirects to the current immutable archive.
- `https://downloads.sidestream.tv/cli/latest.json` returns its version, platform requirements, size, SHA-256, and immutable download URL.
- The exact versioned archive path is public and supports `HEAD` and byte ranges.

`data/cli-release.json` pins the current release, platform/runtime requirements, shared-source content digest, immutable archive path, size, and SHA-256. Run `node --test tests/cli-download-route.test.mjs` to verify the endpoint and private-storage boundary.

FlowState owns the shared CLI source, archive builder, bundled dependencies, and standalone smoke tests. This Website repository owns download-host configuration and publication. A public CLI archive is not an Adobe installer release or a change to paid entitlement.

The Nginx configuration in `ops/nginx/downloads.sidestream.tv.conf` exposes only the exact CLI archive and metadata file. Never add a public alias for `/srv/sidestream/artifacts`, a wildcard CLI directory, or change `/v1/` and `/__sidestream_artifacts/` to publish the CLI. Ordinary and paid installer storage remains behind its existing signed allowlist.

## Publication

1. Build and smoke-test the CLI archive from FlowState. Keep archive filenames and storage pathnames immutable, and retain its SHA-256 and byte count. CLI release identifiers must distinguish changed bytes even when the Adobe package version is unchanged.
2. Upload both archive and release JSON with the existing immutable artifact uploader:

   ```sh
   node scripts/upload-hetzner-artifact.mjs --artifact /absolute/archive.tar.gz --pathname sidestream/cli/RELEASE/archive.tar.gz
   node scripts/upload-hetzner-artifact.mjs --artifact /absolute/release.json --pathname sidestream/cli/RELEASE/release.json
   ```

   The uploader uses `root@2.29.9.121`, `~/.ssh/sidestream_hetzner_ed25519`, and `/srv/sidestream/website-backend/scripts/finalize-hetzner-artifact.mjs`. It hashes both sides, refuses different bytes at an existing pathname, and publishes root-owned `0444` files. Do not use the Adobe installer manifest publisher for CLI releases.
3. Update the exact CLI locations in the tracked Nginx file. `/cli/latest` must target the archive whose immutable JSON is served by `/cli/latest.json`. Keep prior exact archive locations when advancing latest so existing versioned URLs continue working.
4. Run the focused CLI delivery checks and the Website `AGENTS.md` publication checks. Commit on synchronized `main`, push `main:main`, wait for canonical `/version.json` to report the pushed SHA, and verify the ordinary Checkout redirect.
5. Before installing Nginx configuration, compare the live file with its tracked pre-change source and retain a root-only timestamped rollback copy. Install the reviewed config to `/etc/nginx/sites-available/downloads.sidestream.tv` with mode `0644`, run `nginx -t`, then `systemctl reload nginx`. If validation fails, restore the previous file without reloading. No Website service or database restart is needed for these static CLI routes.
6. Verify live latest redirect, JSON, archive `HEAD`, one-byte `206`, full archive size and SHA-256, and standalone execution from the downloaded archive. Also verify unsupported methods, unknown CLI paths, and the direct internal installer path return no bytes. Check the normal installer `HEAD` and signed redirect still work.

Rollback restores the prior reviewed Nginx config, passes `nginx -t`, then reloads Nginx. Keep immutable archives and their metadata; do not overwrite or delete them to roll back latest.
