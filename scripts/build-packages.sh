#!/usr/bin/env bash
# Build dist/jade-shell.rpm and dist/jade-shell.deb with nfpm
# (https://nfpm.goreleaser.com). Run from anywhere; needs nfpm and glib-compile-schemas.
set -euo pipefail
root=$(cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
command -v nfpm >/dev/null || { echo 'nfpm is not installed: https://nfpm.goreleaser.com/install/' >&2; exit 1; }
export JADE_VERSION=${JADE_VERSION:-$(python3 -c 'import jade; print(jade.__version__)')}

rm -rf build/stage dist
mkdir -p build/stage/lib dist
cp -a jade themes templates shell-theme build/stage/lib/
cp -a extension build/stage/extension
# The package version as the extension's version-name, so `jade doctor` can
# tell when the Shell still runs an extension from before an upgrade. Only the
# staged copy: the repo's metadata.json has none, as a checkout has no release.
python3 - build/stage/extension/metadata.json <<'EOF'
import json
import os
import sys

path = sys.argv[1]
with open(path) as f:
    metadata = json.load(f)
metadata['version-name'] = os.environ['JADE_VERSION']
with open(path, 'w') as f:
    f.write(json.dumps(metadata, indent=2) + '\n')
EOF
# The same version for `jade`: setup records it, and the extension compares
# the two at login to finish an update.
sed -i "s/^__version__ = .*/__version__ = '$JADE_VERSION'/" build/stage/lib/jade/__init__.py
glib-compile-schemas --strict build/stage/extension/schemas
find build/stage -name __pycache__ -prune -exec rm -rf {} +

for packager in rpm deb; do
    nfpm package --config packaging/nfpm.yaml --packager "$packager" --target "dist/jade-shell.$packager"
done
(cd dist && sha256sum jade-shell.rpm jade-shell.deb > SHA256SUMS)
# What `jade update` and the extension's daily check read from the latest release.
echo "$JADE_VERSION" > dist/VERSION
echo "Built Jade Shell $JADE_VERSION:"
ls -l dist
