FROM node:20-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src

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
