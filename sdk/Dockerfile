FROM node:20-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --legacy-peer-deps
COPY . .
CMD ["node", "src/demo.js"]
