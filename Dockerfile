FROM node:22.22.1-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .

EXPOSE 4173
CMD ["npm", "start"]
