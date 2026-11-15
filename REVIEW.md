# Maintenance review

Reviewed 2026-11-14 at upstream commit `df783e636a3b16ff6121e84aa66399d30f4e131f`.
The fork matches upstream's latest commit, dated 2026-10-05 ([upstream history](https://github.com/community-scripts/ProxmoxVE-Local/commits/main/)).

The project is repairable. Its Next.js/React/Prisma architecture builds, and the
checked-in SQLite migrations produce the expected schema. Its principal problems
are execution safety, destructive restore sequencing, fork-unaware updates, and
weak verification. A successful build is not evidence that Proxmox operations work.

## Findings, ordered by risk

### P1: Restore preparation and recovery — addressed

The previous flow deleted the original before validating its replacement.
[`restoreService.ts`](src/server/services/restoreService.ts) now copies local
archives into a private job directory and fully scans them before stopping the
original. PBS snapshots are prepared with native `pct restore` into a temporary
stopped guest, then exported with `vzdump`, preserving Proxmox metadata and normal
unprivileged-container ownership. PBS staging never uses `--force`.

A new, verified, synced recovery archive of the stopped original and a durable
`recovery.json` manifest are required before replacement. Native same-VMID
`pct restore --force 1` follows the [native restore path](https://raw.githubusercontent.com/proxmox/pve-container/master/src/PVE/API2/LXC.pm), preserving guest ACLs/pool membership that explicit guest
deletion would discard. Confirmed replacement failures trigger recovery from the
original archive; failed/uncertain recovery leaves the archive and instructions.
Success leaves the replacement stopped, with its source boot setting preserved.
Recovery archives are deliberately retained on success as well as failure.

Only a single storage-backed root disk is supported. Guests with extra mountpoints,
unused disks, custom ID maps, snapshots, locks, protection or HA management fail
before modification. Restore requires free space for the prepared source and the
original recovery archive; PBS also requires staging disk space and a free VMID.
An incomplete staging guest is retained for inspection if its creation/export
cannot be confirmed. The original remains unchanged during preparation.

Restores are serialized in the application and acquire a host lock. On SSH loss
or timeout, the host lock is retained and automatic recovery is suppressed to
avoid racing an operation whose completion is unknown. The command helper frames
remote status separately from SSH status, so a completed Proxmox task exiting 255
is a confirmed failure rather than an assumed disconnection ([Proxmox CLI exit handling](https://raw.githubusercontent.com/proxmox/pve-container/master/src/PVE/CLI/pct.pm)).

### P1: PBS identity consistency — addressed

[`pbsConnection.ts`](src/server/services/pbsConnection.ts) supplies one validated,
quoted repository identity for PBS access and snapshot discovery, including API
token IDs, IPv6 and namespaces. Discovery parses structured JSON, checks guest
identity, and supplies the password/token and fingerprint for each command.
Native restoration uses the PVE storage's credentials and encryption keys; the
saved username/server/datastore must match that storage before staging starts.
The former `root.pxar`-only conversion has been removed.

### P1: Shell-facing backup/configuration inputs — addressed

Shared [`Proxmox schemas`](src/server/lib/proxmoxValidation.ts) enforce VMID ranges,
storage names, volume IDs and snapshot identity. They are applied to backup,
restore, cloning, installed-script writes and stored IDs used for guest commands.
Remote archive filenames, PBS credentials, namespaces and disk paths are quoted.
LXC configuration and rollback writes now use quoted `printf` commands instead of
a fixed heredoc delimiter; arbitrary advanced configuration stays literal data.
Regular configuration fields reject embedded newlines, and configuration writes
are blocked while the target has a restore lock.

### P1: Vulnerable dependencies — critical/high findings addressed

The original lockfile audit reported 31 affected packages: 1 critical, 15 high,
15 moderate. Next.js 16.3.0 was affected by published remote execution advisories,
including [Windows hosting](https://github.com/advisories/GHSA-p293-qw3h-jr36) and
[Linux image optimization](https://github.com/advisories/GHSA-2464-fhr4-w9xw).

Updated Next.js and its ESLint configuration to 16.4.6, aligned Prisma packages
on 7.10.1, and refreshed compatible dependencies through `npm audit fix` without
`--force`. The resulting audit reports 10 moderate affected packages and no high
or critical findings. Remaining chains involve minimatch in the TypeScript ESLint
tooling and postcss-selector-parser in Tailwind typography. These require separate
dependency triage; forced downgrades suggested by npm were not applied. Counts
represent affected packages, not independently exploitable application flaws.

### P1: Execution path checks and shell quoting — addressed in this patch

String-prefix checks accepted sibling directories such as `scripts-other`, and
the normal SSH branch bypassed the local path check. Canonical file validation now
rejects traversal, directories, missing files, and symlinks outside the scripts
root before execution or SSH transfer. SSH accepts both absolute and relative
local paths and quotes the resulting remote path.

In-container environment exports used JSON stringification as shell escaping;
double quotes permit command substitution. Values, filenames, and the nested
`bash -c` payload now use shell argument quoting. This is a boundary check, not
a sandbox: scripts still execute with the application's or SSH account's rights.
It does not protect against a local writer swapping files after validation.

### P1: Fork-aware application updates — addressed

Application release discovery, bootstrap downloads, stable updates and prerelease
updates share `APP_UPDATE_REPOSITORY` / `APP_UPDATE_BRANCH`, defaulting to this
fork. `REPO_URL` still selects helper scripts independently. In-app updates run
the local bootstrap with the selected release tag and never overwrite it with
upstream's bootstrap. Engines and releases that lack the fork-aware contract are
rejected before stopping or modifying the installation. Failed release preparation
is explicitly propagated despite Bash's conditional-function errexit behavior.
Token-bearing curl commands no longer use `eval`.

The fork must publish a release containing these changes before self-updates can
install it. Older releases are intentionally refused. No real updater was executed
against an installation during verification; tests use temporary fixtures and a
mock download command.

### P2: CI and tests gave little assurance — partially addressed

The CI YAML repeated its top-level `permissions` key. Its sole test asserted
`true === true`. Removed the duplicate key, added an explicit typecheck and
noninteractive test command, and added regression coverage for path boundaries,
symlink roots/escapes, SSH path mapping, rejection before transfer, and shell
round trips with metacharacters. Existing placeholder test remains.

ESLint now reports 55 errors and 18 warnings, down from the original 58 errors and 18 warnings.
They include unsafe values as well as style issues. They are not suppressed by
this patch. Resolve this backlog and add lint to CI afterward. UI behavior,
restore, backup, cloning, updater rollback, and SSH failures need integration tests.

### P2: Installation instructions and database locations disagree — partially addressed

Runtime and Prisma configuration default to `data/pve-scripts.db`, the updater's
missing-variable fallback uses `data/settings.db`, and `.env.example` contains
an absolute `/opt/ProxmoxVE-Local` database path while README clones into
`/opt/PVESciptslocal`. Existing databases must not be silently renamed or replaced.
Choose and explicitly set `DATABASE_URL` for the deployment, back up the existing
database and SSH keys, then reconcile all defaults in a migration-aware change.

README now requires Node 24, describes SQLite and actual execution privileges,
and includes `prisma migrate deploy` for new installs. Runtime creates directories,
not tables; the previous automatic-schema claim was incorrect.

### P2: Network and credential trust need a dedicated hardening pass — open

Authentication is optional and disabled in the example configuration; setup is
available over the network. SSH helpers disable host key checking and discard
known hosts. The production configuration emits wildcard CORS headers, allows
images from any HTTP(S) hostname, and the execution WebSocket has no origin check.
Credentials are stored in SQLite and local key files. These choices deserve
explicit deployment policies, host-key enrollment, and request-boundary tests.
The code should be treated as a privileged administrative service on a trusted
network with authentication configured, rather than a sandboxed public service.

## Verification and limits

- Installed the lockfile; used Node 24 for final validation (machine default is 22).
- Production build and TypeScript validation pass on Node 24. ESLint remains at
  55 errors / 18 warnings (previously 58 / 18); the added helpers and regression tests pass
  targeted lint checks.
- Applied all five migrations to a disposable SQLite database; Prisma schema diff
  reported no difference.
- All 97 tests pass through Vitest, including restore failure/recovery sequencing,
  real shell quoting/status framing, PBS identity and fork-aware updater fixtures.
- Production-only dependency audit: 2 moderate affected packages, no high or critical.
- Logo prefetch was deliberately pointed at an unavailable local endpoint to test
  its documented nonfatal behavior; live PocketBase availability is unverified.
- No Proxmox host was contacted; no containers, backups, SSH credentials, update
  jobs, or production databases were changed.

Remaining work is P2: reconcile database configuration, complete the network and
credential hardening pass, clear the lint backlog, and validate the implemented
restore/update paths in a disposable Proxmox environment before production rollout.
