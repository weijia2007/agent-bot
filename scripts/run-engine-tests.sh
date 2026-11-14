#!/usr/bin/env bash
# Reproducible full engine test run for the isolated toolchain. The original repository expects a
# machine-wide dotnet and PowerShell 7; this fork keeps both in .toolchain and points the legacy
# CLI/installer tests at them through explicit environment variables.
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
"$SDK/dotnet.exe" test NexusRelay.slnx -c Release --no-restore \
  -p:RuntimeIdentifiers=win-x64 -p:NuGetAudit=false --nologo 2>&1
