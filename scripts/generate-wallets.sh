#!/bin/bash
# Generates wallets for node1, node2, node3 and user in ./wallets/
# The deployer uses ~/.config/solana/id.json — not generated here.
# Requires: docker compose build deployer

set -e
cd "$(dirname "$0")/.."

mkdir -p wallets shared

docker compose run --rm --entrypoint bash deployer -c '
  for w in node1 node2 node3 user; do
    path="/wallets/$w.json"
    [ -f "$path" ] || solana-keygen new --no-bip39-passphrase -o "$path" --silent
    echo "$w: $(solana-keygen pubkey $path)"
  done
  echo ""
  echo "Airdrop (run locally):"
  for w in node1 node2 node3; do
    echo "  solana airdrop 2 $(solana-keygen pubkey /wallets/$w.json) --url devnet"
  done
  echo "  solana airdrop 1 $(solana-keygen pubkey /wallets/user.json) --url devnet"
' 2>/dev/null
