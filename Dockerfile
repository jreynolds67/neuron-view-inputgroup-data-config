FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY cli.js ./
ENV BOARD_SCHEME=https
ENV BOARD_TLS_REJECT_UNAUTHORIZED=false
# This is a run-to-completion CLI, not a long-running service. Portainer can run it as a
# one-off container/job, passing the command each time, e.g.:
#   docker run --rm neuron-tsl-bulk dump --ip 10.0.0.42 --group 1
#   docker run --rm neuron-tsl-bulk copy --ip 10.0.0.42 --targets 2-36
#   docker run --rm neuron-tsl-bulk copy --ip 10.0.0.42 --targets 2-36 --apply
ENTRYPOINT ["node", "cli.js"]
CMD []
