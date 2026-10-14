FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
COPY tsconfig.json ./
ENV NODE_ENV=production
ENV MEMORYVAULT_DASHBOARD_HOST=0.0.0.0
EXPOSE 8787
CMD ["node", "--import", "tsx", "src/dashboard.ts"]
