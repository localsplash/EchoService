FROM node:20-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src

# uid 100 is a platform invariant, not a coincidence.
#
# identity writes its bootstrap file (/data/config.json) mode 0600 as uid 100,
# and a single-host install mounts that same volume read-only into this
# container. `adduser -S` without -u picks whatever system uid happens to be
# free, which is how this and identity ended up matching by luck rather than
# design — and how they would silently stop matching on a base-image bump.
# So it is pinned here, and in identity, and in EchoWeb.
#
# /data is created and owned so the standalone case works too: with no shared
# volume the first-run wizard writes the file here itself.
# /var/log/echo is where the rotating logs behind /logs go. It is created here
# rather than left to a volume so the viewer works on a bare `docker run` — /data
# is identity's config volume and is mounted read-only on a single-host install,
# which is why the logs cannot live there.
RUN addgroup -S -g 101 app \
 && adduser -S -u 100 -G app app \
 && mkdir -p /media/_tmp /data /var/log/echo \
 && chown -R app:app /app /media /data /var/log/echo
USER app

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8080/ping || exit 1
CMD ["npm", "start"]
