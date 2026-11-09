# Lightweight Node.js base image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application files
COPY . .

# Ensure storage directories exist
RUN mkdir -p /app/data /app/downloads /app/cache

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

# Expose port
EXPOSE 3000

# Start application
CMD ["npm", "start"]
