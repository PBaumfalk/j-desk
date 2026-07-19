FROM node:22-slim AS webbuild
WORKDIR /app
COPY package.json package-lock.json svelte.config.js vite.config.js tsconfig.json ./
COPY packages ./packages
COPY src ./src
COPY static ./static
RUN npm ci && npm run build

FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci --omit=dev --workspace @j-desk/server --include-workspace-root=false
COPY --from=webbuild /app/build ./build
ENV PORT=4810 DATA_DIR=/data WEB_DIR=/app/build
VOLUME /data
EXPOSE 4810
CMD ["npx", "tsx", "packages/server/src/main.ts"]
