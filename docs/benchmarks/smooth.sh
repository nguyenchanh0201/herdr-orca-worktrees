#!/usr/bin/env bash
# Usage: bash smooth.sh <herdr|orca> <outdir>
# Opens a visible shell terminal in the app, records 12 s of Instruments "Animation Hitches" while
# `seq 1 3000000` streams, and probes how fast the app answers a status call (idle vs under load).
set -uo pipefail
APP="$1"; OUT="$2"; mkdir -p "$OUT"
W="$(cd "$(dirname "$0")/../.." && pwd)"
ORCA=/Applications/Orca.app/Contents/Resources/bin/orca
ms() { perl -MTime::HiRes=time -e 'printf "%.0f\n", time*1000'; }
probe() { local t0 t1; t0=$(ms); if [[ $APP == herdr ]]; then herdr-app status >/dev/null 2>&1; else $ORCA status --json >/dev/null 2>&1; fi; t1=$(ms); echo $((t1 - t0)); }

if [[ $APP == herdr ]]; then
  SPACE=$(herdr-app do space.new "{\"name\":\"bench\",\"folder\":\"$W\"}" | node -e 'const d=JSON.parse(require("fs").readFileSync(0));console.log(d.space+" "+d.terminal)')
  read -r SP T <<<"$SPACE"; PID=$(pgrep -x Herdr); open -a Herdr
  send() { hc send "$T" "$1" >/dev/null; }
else
  T=$($ORCA terminal create --worktree "path:$W" --title bench --focus --json | node -e 'const d=JSON.parse(require("fs").readFileSync(0));console.log(d.result.terminal.handle)')
  PID=$(pgrep -x Orca | head -1); open -a Orca
  send() { $ORCA terminal send --terminal "$T" --text "$1" --enter --json >/dev/null; }
fi
sleep 4

for i in 1 2 3 4 5 6 7 8; do probe; sleep 0.3; done > "$OUT/$APP-probe-idle.txt"

rm -rf "$OUT/$APP.trace"
xcrun xctrace record --template 'Animation Hitches' --attach "$PID" --time-limit 12s --output "$OUT/$APP.trace" >/dev/null 2>&1 &
REC=$!
sleep 2
echo "$(ms)" > "$OUT/$APP-burst-start.txt"
send "seq 1 3000000"
for i in $(seq 1 20); do probe; sleep 0.3; done > "$OUT/$APP-probe-load.txt"
wait $REC

xcrun xctrace export --input "$OUT/$APP.trace" --xpath '/trace-toc/run[@number="1"]/data/table[@schema="hitches-frame-lifetimes"]' > "$OUT/$APP-frames.xml" 2>/dev/null
xcrun xctrace export --input "$OUT/$APP.trace" --xpath '/trace-toc/run[@number="1"]/data/table[@schema="potential-hangs"]' > "$OUT/$APP-hangs.xml" 2>/dev/null

if [[ $APP == herdr ]]; then herdr-app do space.close "{\"id\":\"$SP\",\"confirmed\":true}" >/dev/null
else $ORCA terminal close --terminal "$T" --json >/dev/null; fi
echo "$APP done"
