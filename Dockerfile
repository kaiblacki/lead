# AI Agency OS – Produktions-Image (Node 22, TypeScript läuft direkt, kein Build-Schritt).
# Bauen:  docker build -t agency-os .            (optional mit Browser-Test: --build-arg WITH_CHROMIUM=1)
# Starten: docker run -d --env-file .env -e PUBLIC_BASE_URL=https://deine-domain.de -e TRUST_PROXY=1 -v agency-out:/app/out -p 3000:3000 agency-os
# Alle Variablen: .env.example. Geheimnisse gehören in --env-file/Secrets des Hosters, niemals in das Image.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
# Optional: Chromium für den Browser-Test der Kundenseiten (QA) und die Tiefenprüfung. Ohne: QA läuft statisch, der Browser-Teil wird als Hinweis übersprungen.
ARG WITH_CHROMIUM=0
RUN if [ "$WITH_CHROMIUM" = "1" ]; then apt-get update && apt-get install -y --no-install-recommends chromium fonts-liberation && rm -rf /var/lib/apt/lists/*; fi
ENV CHROMIUM_PATH=/usr/bin/chromium
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && node -e "process.exit(process.features.typescript ? 0 : 1)"
COPY src ./src
COPY config ./config
COPY config.mock ./config.mock
COPY templates ./templates
# Schreibbarer Ordner für „veröffentlichte“ Kundenseiten ohne Vercel-Token (als Volume mounten)
RUN mkdir -p out && chown -R node:node out
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Produktionsbefehl (DASHBOARD_PASSWORD, DATABASE_URL, OWNER_ID müssen gesetzt sein, sonst beendet sich der Server mit einer Fehlermeldung)
CMD ["node", "src/serve.ts"]
