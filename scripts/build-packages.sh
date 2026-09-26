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
# MacTahoe's release, the pinned one jade/icons.py names, checked against its
# SHA-256 and kept in build/cache between builds. The package ships only the
# parts setup reads (icons.PARTS), repacked the same way each time, with that
# copy's own SHA-256 in jade/_icons_sha.py, for setup to build the Tahoe icons
# from without a download. jade.store needs GNOME's libraries, and nothing
# read here uses it.
mapfile -t release < <(python3 -B -c '
import sys
import types

sys.modules["jade.store"] = types.SimpleNamespace(data_home=None)
from jade import icons

print(icons.TAG, icons.URL, icons.SHA256, sep="\n")
print(*icons.PARTS, sep="\n")')
tag=${release[0]} url=${release[1]} sha=${release[2]}
parts=("${release[@]:3}")
[ ${#parts[@]} -gt 0 ] || { echo 'could not read the MacTahoe release from jade/icons.py' >&2; exit 1; }
archive=build/cache/MacTahoe-icon-theme-$tag.tar.gz
mkdir -p build/cache build/stage/lib/icons
if ! echo "$sha  $archive" | sha256sum --check --status 2>/dev/null; then
    curl -fsSL --retry 3 -o "$archive.part" "$url"
    echo "$sha  $archive.part" | sha256sum --check --status ||
        { rm -f "$archive.part"; echo "MacTahoe $tag did not match its checksum" >&2; exit 1; }
    mv "$archive.part" "$archive"
fi
rm -rf build/mactahoe && mkdir build/mactahoe
tar -xzf "$archive" -C build/mactahoe
trimmed=build/stage/lib/icons/MacTahoe-jade-$tag.tar.xz
(cd build/mactahoe && LC_ALL=C tar --create --format=gnu --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
    --mode=u=rwX,go=rX --exclude='*.png' --exclude='*.jpg' "${parts[@]/#/MacTahoe-icon-theme-$tag/}") |
    xz -9e -T1 > "$trimmed"
rm -rf build/mactahoe
printf "# The SHA-256 of icons/%s, written by scripts/build-packages.sh.\nSHA256 = '%s'\n" \
    "${trimmed##*/}" "$(sha256sum "$trimmed" | cut -d' ' -f1)" > build/stage/lib/jade/_icons_sha.py
find build/stage -name __pycache__ -prune -exec rm -rf {} +

for packager in rpm deb; do
    nfpm package --config packaging/nfpm.yaml --packager "$packager" --target "dist/jade-shell.$packager"
done
(cd dist && sha256sum jade-shell.rpm jade-shell.deb > SHA256SUMS)
# What `jade update` and the extension's daily check read from the latest release.
echo "$JADE_VERSION" > dist/VERSION
echo "Built Jade Shell $JADE_VERSION:"
ls -l dist
