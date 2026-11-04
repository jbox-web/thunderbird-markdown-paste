#!/bin/sh
# Packages the add-on: only what the manifest needs, never tests or tooling.
set -eu
cd "$(dirname "$0")/.."
version=$(node -p 'require("./manifest.json").version')
mkdir -p dist
out="dist/markdown-paste-$version.xpi"
rm -f "$out"
zip -q -X -r "$out" manifest.json background.js LICENSE src vendor icons -x "*.DS_Store"
echo "$out"
