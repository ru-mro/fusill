FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --legacy-peer-deps

COPY . .

# Compile the native SYN flood helper (raw-socket sender used by the synFlood
# runner). Built here so the image is self-contained — the binary is gitignored
# and never shipped. gcc is installed only for the build and then removed.
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev \
    && gcc -O2 -o src/runners/syn_flood src/runners/syn_flood.c \
    && apt-get purge -y gcc libc6-dev && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

CMD ["node", "src/index.js"]
