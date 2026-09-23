#!/bin/sh
find /usr/share/jade-shell -name __pycache__ -type d -prune -exec rm -rf {} + 2>/dev/null || true
