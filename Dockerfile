FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY src ./src
COPY skills ./skills
COPY tsconfig.json ./
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/skills ./skills

ENV NODE_ENV=production
ENV WORKING_DIR=/data
ENV PORT=8080

RUN mkdir -p /data
WORKDIR /data

EXPOSE 8080
CMD ["node", "/app/dist/main.js"]
