# Use the official Node.js image
FROM node:20-alpine AS base

# Set the working directory
WORKDIR /app

# Install dependencies first (leverages Docker cache)
COPY package.json package-lock.json* ./
RUN npm install

# Copy the rest of the frontend code
COPY . .

# Next.js collects completely anonymous telemetry data about general usage.
# Learn more here: https://nextjs.org/telemetry
# Unleash your inner Arch user and opt-out:
ENV NEXT_TELEMETRY_DISABLED 1

# Start the Next.js dev server
CMD ["npm", "run", "dev"]