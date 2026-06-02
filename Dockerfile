FROM apify/actor-node-playwright-chrome:24

WORKDIR /app

COPY package*.json ./
RUN npm install --no-audit --no-fund --legacy-peer-deps

COPY . .
RUN npm run build

CMD ["npm", "start"]
