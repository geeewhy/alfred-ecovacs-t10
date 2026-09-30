#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
model=vosk-model-small-en-us-0.15
archive=$(mktemp)
trap 'rm -f "$archive"' EXIT
curl -fLsS "https://alphacephei.com/vosk/models/$model.zip" -o "$archive"
python3 - "$archive" <<'PY'
import hashlib,sys
assert hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest() == '30f26242c4eb449f948e42cb302dd7a686cb29a3423a8367f99ff41780942498', 'Wake model checksum mismatch'
PY
mkdir -p artifacts/voice-models
unzip -qo "$archive" -d artifacts/voice-models
