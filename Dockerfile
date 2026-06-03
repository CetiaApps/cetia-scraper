FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN npm install -g pnpm

COPY package.json ./
RUN pnpm install --no-frozen-lockfile --ignore-scripts

COPY . .
RUN pnpm run build

EXPOSE 3000

CMD ["pnpm", "start"]
