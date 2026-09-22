FROM node:22-alpine AS build
WORKDIR /app
COPY mcp-server/package.json mcp-server/package-lock.json ./mcp-server/
RUN npm ci --prefix mcp-server
COPY mcp-server ./mcp-server
RUN npm run build --prefix mcp-server && npm run smoke --prefix mcp-server

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/mcp-server ./mcp-server
WORKDIR /app/mcp-server
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
