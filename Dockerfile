FROM mcr.microsoft.com/playwright:v1.48.2-jammy

WORKDIR /app

RUN npm install -g pnpm

COPY package.json ./

RUN pnpm install --no-frozen-lockfile

COPY . .

RUN pnpm run build

EXPOSE 3000

CMD ["pnpm", "start"]
