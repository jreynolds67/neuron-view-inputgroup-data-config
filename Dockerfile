FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY cli.js ./
ENV BOARD_SCHEME=https
ENV BOARD_TLS_REJECT_UNAUTHORIZED=false
# Idle so the container stays up in Portainer. Run the tool via the container Console:
#   node cli.js dump --ip 10.0.0.42 --group 1
#   node cli.js copy --ip 10.0.0.42 --targets 2-36
#   node cli.js copy --ip 10.0.0.42 --targets 2-36 --apply
CMD ["tail", "-f", "/dev/null"]
