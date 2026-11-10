FROM node:20-slim
WORKDIR /app
RUN apt-get update && apt-get install -y unzip && rm -rf /var/lib/apt/lists/*
COPY app.zip ./
RUN unzip -q app.zip && rm app.zip
RUN npm install --omit=dev
ENV PORT=7860
EXPOSE 7860
CMD ["node", "server.js"]
