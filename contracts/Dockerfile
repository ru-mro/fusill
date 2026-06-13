FROM rust:latest

RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    libudev-dev \
    curl \
    git \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Node.js 20 (needed for anchor test and the TypeScript dependencies)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    npm install -g yarn && \
    rm -rf /var/lib/apt/lists/*

# Solana CLI
ENV PATH="/root/.local/share/solana/install/active_release/bin:$PATH"
RUN sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"

# Anchor via AVM
RUN cargo install --git https://github.com/coral-xyz/anchor avm --force
RUN avm install latest && avm use latest
ENV PATH="/root/.avm/bin:$PATH"

# Generate a Solana keypair for the provider (required by anchor build/test)
RUN solana-keygen new --no-bip39-passphrase -o /root/.config/solana/id.json

WORKDIR /workspace
