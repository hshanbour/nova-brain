# Dedicated private Fresha executor; provisioned within the approved hosting scope.
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium xvfb x11vnc novnc websockify tini ca-certificates fonts-liberation && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src/booking ./src/booking/
COPY src/autonomy/local-worker-client.js ./src/autonomy/
COPY fresha-executor ./fresha-executor
RUN chmod 755 /app/fresha-executor/start.sh
ENV DISPLAY=:99
ENTRYPOINT ["/usr/bin/tini", "--", "/app/fresha-executor/start.sh"]
