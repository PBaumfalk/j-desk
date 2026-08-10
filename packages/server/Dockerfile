# Node 22 ist die verbindliche Zielversion des Projekts (OPS-01, D-A) — dieses Basisimage ist
# der Anker der Entscheidung: `engines.node` in der Root-package.json, `.nvmrc` und
# `.node-version` ziehen auf diesen Wert nach, ein Wächtertest
# (packages/server/src/nodeVersion.test.ts) bricht bei jedem Suite-Lauf, sobald eine der vier
# Stellen wieder ausschert. Siehe docs/deployment/update-runbook.md.
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
# Sprachdaten für die deutsche OCR (SEARCH-03, T-07-32): das Verzeichnis wird immer kopiert
# (leer, falls keine deu.traineddata vorliegt — die .gitignore-Regel schließt sie aus dem
# Build-Kontext aus). Kein `RUN curl`-Download hier: der Bauvorgang bleibt netzunabhängig, die
# Datei wird beim Bauen ins Verzeichnis gelegt oder zur Laufzeit per Volume bereitgestellt.
# `TESSDATA_DIR` kann bei Bedarf auf einen anderen Ablageort zeigen (packages/server/src/ocr/tessdata.ts).
COPY packages/server/tessdata ./packages/server/tessdata
ENV PORT=4810 DATA_DIR=/data WEB_DIR=/app/build
VOLUME /data
EXPOSE 4810
CMD ["npx", "tsx", "packages/server/src/main.ts"]
