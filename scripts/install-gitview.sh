#!/usr/bin/env bash
# Compatibility entry point: gitview is now part of the standard install.
set -euo pipefail
exec bash "$(dirname "$0")/install.sh" "$@"
