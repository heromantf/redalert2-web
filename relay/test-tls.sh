#!/bin/bash
# test-tls.sh: the relay on wss:// with a certificate, then another in its files and SIGHUP: the next
# handshake has it, a page joined before stays, one that does not load leaves the last (test-tls.mjs).
# Against ../out/relay (go build -o ../out/relay .); needs openssl and Node.
cd "$(dirname "$0")" && . ../tools/env.sh
D=$(mktemp -d "${TMPDIR:-/tmp}/relay-tls.XXXXXX")
RP=
trap 'kill $RP 2>/dev/null; rm -rf "$D"' EXIT
for n in A B; do
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 2 -subj "/CN=relay-$n" \
    -addext "subjectAltName=IP:127.0.0.1" -keyout "$D/$n.key" -out "$D/$n.crt" 2>/dev/null || { echo "openssl failed"; exit 1; }
done
cat "$D/A.crt" "$D/B.crt" > "$D/both.crt"; cp "$D/A.crt" "$D/cert.pem"; cp "$D/A.key" "$D/key.pem"
../out/relay -addr 127.0.0.1:8795 -tls-cert "$D/cert.pem" -tls-key "$D/key.pem" > "$D/relay.log" 2>&1 &
RP=$!
sleep 1
NODE_EXTRA_CA_CERTS="$D/both.crt" node test-tls.mjs "$D" "$RP"; r=$?
cat "$D/relay.log"
exit $r
