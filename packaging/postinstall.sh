#!/bin/sh
# Byte-compile for the Python /usr/bin/jade runs; removed again before removal.
/usr/bin/python3 -m compileall -q /usr/share/jade-shell/jade >/dev/null 2>&1 || true
