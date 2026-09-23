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
glib-compile-schemas --strict build/stage/extension/schemas
find build/stage -name __pycache__ -prune -exec rm -rf {} +

for packager in rpm deb; do
    nfpm package --config packaging/nfpm.yaml --packager "$packager" --target "dist/jade-shell.$packager"
done
(cd dist && sha256sum jade-shell.rpm jade-shell.deb > SHA256SUMS)
echo "Built Jade Shell $JADE_VERSION:"
ls -l dist
