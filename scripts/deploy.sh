#!/bin/bash
set -e
cd /workspace

echo "=== Fusill — Deploy to Devnet ==="

# Program keypair management
mkdir -p target/deploy
if [ -f /wallets/program-keypair.json ]; then
  cp /wallets/program-keypair.json target/deploy/fusill-keypair.json
elif [ ! -f target/deploy/fusill-keypair.json ]; then
  solana-keygen new --no-bip39-passphrase -o target/deploy/fusill-keypair.json --silent
fi
cp target/deploy/fusill-keypair.json /wallets/program-keypair.json

PROGRAM_ID=$(solana-keygen pubkey target/deploy/fusill-keypair.json)
echo "Program ID: $PROGRAM_ID"

# Patch Anchor.toml for the build: cluster=devnet + correct ID in [programs.devnet]
cp Anchor.toml Anchor.toml.bak
sed -i 's/cluster = "localnet"/cluster = "devnet"/' Anchor.toml
awk -v id="$PROGRAM_ID" '
  /^\[programs\.devnet\]/ { devnet=1 }
  /^\[/ && !/^\[programs\.devnet\]/ { devnet=0 }
  devnet && /^fusill/ { print "fusill = \"" id "\""; next }
  { print }
' Anchor.toml > /tmp/anchor.toml && mv /tmp/anchor.toml Anchor.toml

# Install JS deps (needed for initialize.js)
yarn install --frozen-lockfile --silent 2>/dev/null || yarn install --silent

# Build with the correct program ID embedded
echo "--- anchor build ---"
anchor build

# Restore Anchor.toml (localnet for tests)
mv Anchor.toml.bak Anchor.toml

# Deploy or upgrade depending on whether the program already exists on devnet
echo "--- anchor deploy / upgrade ---"
if solana program show "$PROGRAM_ID" --url devnet > /dev/null 2>&1; then
  echo "Existing program detected — upgrading..."
  solana program deploy target/deploy/fusill.so \
    --program-id target/deploy/fusill-keypair.json \
    --keypair /wallets/deployer.json \
    --url devnet \
    --skip-preflight \
    --max-sign-attempts 20
else
  echo "First time — deploying..."
  anchor deploy \
    --provider.cluster devnet \
    --provider.wallet /wallets/deployer.json
fi

# Copy IDL to /shared and set the address to the real program ID
cp target/idl/fusill.json /shared/fusill-idl.json
node -e "
  const fs = require('fs');
  const idl = JSON.parse(fs.readFileSync('/shared/fusill-idl.json', 'utf8'));
  idl.address = '${PROGRAM_ID}';
  fs.writeFileSync('/shared/fusill-idl.json', JSON.stringify(idl, null, 2));
"
echo "IDL saved to /shared/fusill-idl.json"

# Initialize Config account
echo "--- initialize ---"
node /workspace/scripts/initialize.js

echo ""
echo "=== Deploy complete ==="
echo "Program ID: $PROGRAM_ID"
echo ""
echo "Next step:"
echo "  docker compose up node1 node2 node3 mock-target"
