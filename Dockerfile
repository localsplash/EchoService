FROM node:20-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
RUN mkdir -p /media/_tmp && chown -R node:node /media
EXPOSE 8080
CMD ["npm", "start"]
