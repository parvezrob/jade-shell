#!/usr/bin/env bash
# Install, set up, restore and remove the built packages on fresh Fedora and
# Ubuntu containers. Build them first with scripts/build-packages.sh.
set -euo pipefail
root=$(cd -- "$(dirname -- "$0")/.." && pwd)
engine=$(command -v podman || command -v docker) || { echo 'needs podman or docker' >&2; exit 1; }
for image in ${IMAGES:-registry.fedoraproject.org/fedora:44 docker.io/library/ubuntu:26.04}; do
    echo "##### $image"
    # Privileged, as on a desktop: image loading (glycin) sandboxes itself with bwrap.
    "$engine" run --rm --privileged -v "$root/dist:/pkg:ro,Z" -v "$root/tests/package-smoke.sh:/smoke.sh:ro,Z" "$image" bash /smoke.sh
done
