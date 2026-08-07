# Use an official Node runtime as a parent image (slim for smaller size)
FROM node:20-alpine

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install dependencies (including Prisma)
RUN npm install

# Copy Prisma schema and configuration
COPY prisma ./prisma
COPY prisma.config.js ./

# Generate Prisma Client
RUN npx prisma generate

# Copy the rest of the application code
COPY . .

# Expose the port the app runs on
EXPOSE 4005

# Define the command to run the app
CMD ["node", "src/index.js"]
