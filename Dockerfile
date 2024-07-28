# Use the official Node.js image based on Alpine Linux as the base image
FROM node:alpine

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (if exists) from the host to the container's working directory
COPY package*.json .

# Install dependencies defined in package.json inside the container
RUN npm install

# Copy all the files from the host to the container's working directory
COPY . .

# Define the command that will be executed when the container starts
CMD [ "npm", "start" ]