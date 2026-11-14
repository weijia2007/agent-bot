#!/usr/bin/env bash
# Build once, then run selected xUnit v3 tests by exact method name under the isolated toolchain.
# Usage: bash scripts/run-targeted-tests.sh <fully-qualified-method> [more methods...]
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SDK="$ROOT/.toolchain/dotnet"
RT="$ROOT/.toolchain/runtime"

export DOTNET_ROOT="$SDK"
export PATH="$SDK:$RT:$PATH"
export DOTNET_CLI_TELEMETRY_OPTOUT=1
export DOTNET_NOLOGO=1
export NEXUS_BOT_DOTNET_EXE="$SDK/dotnet.exe"
export NEXUS_BOT_PWSH_EXE="$RT/$(printf 'pwsh.exe')"
export NEXUS_BOT_PWSH_MODULES="$RT/Modules"

cd "$ROOT/engine" || exit 1
"$SDK/dotnet.exe" build NexusRelay.slnx -c Release --no-restore \
  -p:RuntimeIdentifiers=win-x64 -p:NuGetAudit=false --nologo || exit 1

ARGS=()
for m in "$@"; do ARGS+=("-method" "$m"); done
"$ROOT/engine/.build/NexusRelay.Tests/bin/Release/net10.0-windows/NexusRelay.Tests.exe" "${ARGS[@]}" 2>&1
