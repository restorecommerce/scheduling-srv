### Build
FROM node:22.11.0-alpine3.20 as build
ENV NO_UPDATE_NOTIFIER=true

USER node
ARG APP_HOME=/home/node/srv
WORKDIR $APP_HOME

COPY package.json package.json
COPY package-lock.json package-lock.json

RUN npm ci

COPY --chown=node:node . .

RUN npm run build


### Deployment
FROM node:22.11.0-alpine3.20 as deployment

ENV NO_UPDATE_NOTIFIER=true

USER node
ARG APP_HOME=/home/node/srv
WORKDIR $APP_HOME

COPY --chown=node:node . $APP_HOME
COPY --chown=node:node --from=build $APP_HOME/lib $APP_HOME/lib

EXPOSE 50051

USER root
USER node

CMD [ "node", "./lib/start.cjs" ]
