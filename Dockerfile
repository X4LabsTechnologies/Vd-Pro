FROM mcr.microsoft.com/playwright:v1.40.1-jammy

WORKDIR /app

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY config ./config
COPY src ./src
COPY README.md ./

RUN useradd --create-home --shell /bin/bash vdpro \
    && chown -R vdpro:vdpro /app
USER vdpro

EXPOSE 3000

CMD ["node", "server.js"]
