#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT_DIR="$ROOT/resources/cert"
FORCE="${1:-}"

mkdir -p "$CERT_DIR"

if [ -f "$CERT_DIR/ca.key" ] && [ "$FORCE" != "--force" ]; then
  echo "Local certificate keys already exist. Re-run with --force to replace them."
  exit 0
fi

OPENSSL="${OPENSSL_BIN:-/usr/bin/openssl}"

"$OPENSSL" req -x509 -newkey rsa:2048 -nodes \
  -keyout "$CERT_DIR/ca.key" \
  -out "$CERT_DIR/ca.crt" \
  -days 3650 \
  -subj "/CN=Codex Guardian Local CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"

"$OPENSSL" req -newkey rsa:2048 -nodes \
  -keyout "$CERT_DIR/server.key" \
  -out "$CERT_DIR/server.csr" \
  -subj "/CN=127.0.0.1"

"$OPENSSL" x509 -req \
  -in "$CERT_DIR/server.csr" \
  -CA "$CERT_DIR/ca.crt" \
  -CAkey "$CERT_DIR/ca.key" \
  -CAcreateserial \
  -out "$CERT_DIR/server.crt" \
  -days 825 \
  -sha256 \
  -extfile "$CERT_DIR/ext.cnf"

cp "$CERT_DIR/server.key" "$CERT_DIR/llm-proxy.key"
cp "$CERT_DIR/server.crt" "$CERT_DIR/llm-proxy.crt"

echo "Generated local-only certificate files under $CERT_DIR"
echo "Private *.key files are ignored by Git and excluded from public release snapshots."
