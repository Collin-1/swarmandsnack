# syntax=docker/dockerfile:1

FROM node:20-alpine
WORKDIR /app

COPY Server/package.json ./Server/package.json
RUN cd Server && npm install --omit=dev

COPY Server ./Server

ENV PORT=8080
EXPOSE 8080
CMD ["npm", "--prefix", "Server", "start"]
