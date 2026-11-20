FROM node:22-alpine
WORKDIR /app
COPY server.js index.html nginx.conf manifest.webmanifest icon.svg ./
ENV DATA_DIR=/data PORT=8080
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node","server.js"]
