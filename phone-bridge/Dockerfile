FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY phone-bridge ./phone-bridge
USER node
CMD ["node", "phone-bridge/server.js"]
