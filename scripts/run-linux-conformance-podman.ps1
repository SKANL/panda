$ErrorActionPreference = 'Stop'

podman machine inspect podman-machine-default *> $null
if ($LASTEXITCODE -ne 0) { throw 'The podman-machine-default VM does not exist.' }
$machine = podman machine inspect podman-machine-default | ConvertFrom-Json
if ($machine.State -ne 'running') { throw 'Start podman-machine-default before running Linux conformance.' }

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$mount = $repo.Replace('\', '/')
$command = @'
set -eu
apt-get update -qq
apt-get install --no-install-recommends -y bubblewrap >/dev/null
corepack enable
rm -rf /tmp/panda
mkdir /tmp/panda
tar -C /workspace --exclude=node_modules --exclude=.git -cf - . | tar -C /tmp/panda -xf -
cd /tmp/panda
CI=1 corepack pnpm install --frozen-lockfile
PANDA_RUN_SANDBOX_CONFORMANCE=1 CI=1 corepack pnpm --filter @skanl/panda-sandbox-local exec vitest run test/host-conformance/linux.test.ts
'@

& podman run --rm --privileged -e CI=1 -v "${mount}:/workspace:ro" node:24-bookworm sh -lc $command
if ($LASTEXITCODE -ne 0) { throw 'Linux sandbox conformance failed inside the Podman Linux VM.' }
