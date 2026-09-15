FROM node:20-alpine
ENV TZ=America/Los_Angeles
RUN apk add --no-cache tzdata
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
COPY scripts/write-build-info.mjs scripts/
ARG BUILD_REVISION
ARG SOURCE_DATE_EPOCH
ARG BUILD_DIRTY
RUN npm run build

# Preserve existing media/log volume ownership. uid 100 no longer needs to
# match Identity: NocoDB credentials are injected per service.
RUN addgroup -S -g 101 app \
 && adduser -S -u 100 -G app app \
 && mkdir -p /media/_tmp /var/log/echo \
 && chown -R app:app /app /media /var/log/echo
USER app

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8080/ping || exit 1
CMD ["npm", "start"]
