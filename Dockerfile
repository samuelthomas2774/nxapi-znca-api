FROM node:19 as build

WORKDIR /app

ADD package.json /app
ADD package-lock.json /app

RUN npm install

COPY src /app/src
ADD tsconfig.json /app

RUN npx tsc

FROM node:19

RUN apt update && \
    apt install -y android-tools-adb && \
    apt-get clean

WORKDIR /app

ADD package.json /app
ADD package-lock.json /app

RUN npm ci --omit=dev

COPY bin /app/bin
COPY resources /app/resources
COPY --from=build /app/dist /app/dist

RUN ln -s /app/bin/nxapi-znca-api.js /usr/local/bin/nxapi-znca-api
ENV NXAPI_DATA_PATH=/data
ENV NODE_ENV=production

RUN ln -s /data/android /root/.android

VOLUME [ "/data" ]

ENTRYPOINT [ "/app/resources/docker-entrypoint.sh" ]
CMD [ "--help" ]
