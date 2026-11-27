#!/bin/sh
# Dev-only regression test for `wfinfo-mac rewards` (not part of the app).
#
# Draws synthetic reward screens with `wfinfo-mac synth` and checks that
# `rewards` returns every name line the screen shows. Case "wrapped-white"
# is the screen where Vision dropped the wrapped "BLUEPRINT" under
# "ASH PRIME NEUROPTICS" when it read the strip as one wide crop.
#
# Usage: headless/macos/tests/rewards_regression.sh [path/to/wfinfo-mac]
# Exit 0 when every case passes, 1 otherwise. Needs macOS 15+ and python3.
set -u
HELPER="${1:-$(dirname "$0")/../../bin/Debug/net9.0/wfinfo-mac}"
[ -x "$HELPER" ] || { echo "wfinfo-mac not found at $HELPER (build headless first)"; exit 2; }
WORK=$(mktemp -d "${TMPDIR:-/tmp}/wfinfo-rewards-test.XXXXXX") || exit 2
trap 'rm -rf "$WORK"' EXIT INT TERM

FAILED=0
check() { # name width height ui-scale colour seed names squad
  name=$1; shift
  "$HELPER" synth --out "$WORK/$name.png" --width "$1" --height "$2" --ui-scale "$3" \
    --color "$4" --seed "$5" --names "$6" --squad "$7" > "$WORK/$name.truth.json" || { echo "FAIL $name: synth"; FAILED=1; return; }
  "$HELPER" rewards --file "$WORK/$name.png" --reward-width 968 --reward-height 235 --reward-y 316 \
    --line-height 48 --ui-scale "$3" > "$WORK/$name.read.json" || { echo "FAIL $name: rewards"; FAILED=1; return; }
  if python3 -I - "$WORK/$name.truth.json" "$WORK/$name.read.json" <<'PY'
import json, sys
truth = json.load(open(sys.argv[1]))
read = [l["text"].upper() for l in json.load(open(sys.argv[2]))["lines"]]
want = [l["text"].upper() for s in truth["slots"] for l in s["lines"]]
missing = [w for w in want if w not in read]
if missing:
    print("  missing:", missing, " read:", read)
sys.exit(1 if missing else 0)
PY
  then echo "PASS $name"; else echo "FAIL $name"; FAILED=1; fi
}

check wrapped-white 1920 1080 0.9 "#FFFFFF" 7 \
  "Volt Prime Systems|Ash Prime Neuroptics Blueprint|Forma Blueprint|Akstiletto Prime Barrel" \
  "Tenno1|Tenno2|Tenno3|Tenno4"
check wrapped-white-real 1920 1080 0.9 "#FFFFFF" 7 \
  "Volt Prime Systems Blueprint|Ash Prime Neuroptics Blueprint|Nekros Prime Chassis Blueprint|Soma Prime Stock" \
  "Tenno1|Tenno2|Tenno3|Tenno4"
check four-gold 1920 1080 1.0 "#BEA966" 1 \
  "Volt Prime Blueprint|Hydroid Prime Neuroptics Blueprint|Forma Blueprint|Paris Prime Upper Limb" "a|b|c|d"
check three-white-80 2560 1440 0.8 "#FFFFFF" 2 \
  "Nikana Prime Hilt|Akstiletto Prime Barrel|Braton Prime Receiver" "Ash|Mag Main|"
check two-blue-ultrawide 3440 1440 1.0 "#6EC3E8" 3 "Rhino Prime Chassis Blueprint|Lex Prime Barrel" "Solo|Duo"
check one-gold-125 1728 1117 1.25 "#BEA966" 4 "Trinity Prime Systems Blueprint" ""
exit $FAILED
