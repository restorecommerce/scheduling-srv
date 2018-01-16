FROM node:9.2.0-wheezy

RUN apt-get update && apt-get install -y libc6-dev

# Create app directory
RUN mkdir -p /usr/share/scheduling-srv
RUN mkdir -p /root/.ssh
WORKDIR /usr/share/scheduling-srv

# Set config volumes
VOLUME /usr/share/scheduling-srv/cfg
VOLUME /usr/share/scheduling-srv/protos

# Bundle app source
COPY . /usr/share/scheduling-srv

# Install app dependencies
RUN npm install -g typescript

RUN cd /usr/share/scheduling-srv
COPY id_rsa /root/.ssh/
COPY config /root/.ssh/
COPY known_hosts /root/.ssh/

RUN npm install
RUN npm run postinstall

EXPOSE 50051
CMD [ "npm", "start" ]

# To build the image:
# docker build -t restorecommerce/scheduling-srv .
#
# To create a container:
# docker create --name scheduling-srv --net system_default restorecommerce/scheduling-srv
#
# To run the container:
# docker start scheduling-srv
