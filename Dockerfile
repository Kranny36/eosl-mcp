# eosl-mcp — stdio MCP server. Starts and answers introspection (initialize / tools/list) with no
# configuration and no credentials; tool calls fetch public CC BY 4.0 data from https://eosl.ai.
FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
# Zero dependencies — nothing to install.
USER node
ENTRYPOINT ["node", "server.js"]
