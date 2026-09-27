FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

FROM node:20-alpine
WORKDIR /app
ARG AUTH2API_BUILD_ID=unverified
ENV AUTH2API_BUILD_ID=${AUTH2API_BUILD_ID}
LABEL org.opencontainers.image.revision=${AUTH2API_BUILD_ID}
COPY --from=builder /app/dist dist/
COPY --from=builder /app/node_modules node_modules/
COPY package.json ./
EXPOSE 8317
VOLUME ["/data", "/config"]
ENV NODE_ENV=production
CMD ["node", "dist/index.js", "--config=/config/config.yaml"]
