FROM node:20-alpine

WORKDIR /app

COPY client/package*.json client/
COPY frontend/package*.json frontend/
RUN npm --prefix client ci && npm --prefix frontend ci

COPY client/ client/
COPY frontend/ frontend/
WORKDIR /app/frontend
RUN npm run build

EXPOSE 3000

CMD ["npm", "run", "start", "--", "-H", "0.0.0.0", "-p", "3000"]
