### Build
FROM node:26-alpine3.24 AS build
ENV NO_UPDATE_NOTIFIER=true

USER node
ARG APP_HOME=/home/node/srv
WORKDIR $APP_HOME

COPY package.json package.json
COPY package-lock.json package-lock.json

COPY --chown=node:node . .

RUN npm ci
RUN npm run build


### Deployment
FROM node:26-alpine3.24 AS deployment

ENV NO_UPDATE_NOTIFIER=true

USER node
ARG APP_HOME=/home/node/srv
WORKDIR $APP_HOME

COPY --chown=node:node ./cfg $APP_HOME/cfg
COPY --chown=node:node --from=build $APP_HOME/dist $APP_HOME/dist

EXPOSE 50051

CMD [ "node", "./dist/start.cjs" ]
