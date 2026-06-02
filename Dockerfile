FROM mcr.microsoft.com/playwright:v1.48.2-jammy

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml* ./

RUN pnpm install --frozen-lockfile=false

COPY . .

RUN pnpm run build

EXPOSE 3000

CMD ["pnpm", "start"]
