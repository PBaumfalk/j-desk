FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci --omit=dev --workspace @digital-desktop/server --include-workspace-root=false
ENV PORT=4810 DATA_DIR=/data
VOLUME /data
EXPOSE 4810
CMD ["npx", "tsx", "packages/server/src/main.ts"]
