# Farmcontrol Print Host

A TCP Server designed to recieve data from Marlin's serial connection via a TCP to IP hardware bridge (like the one found here: https://www.waveshare.com/uart-to-eth.htm

The host software supports multiple connections and can be controlled via Socket.io, using farmcontrol-ws.

## Installation

```
git clone https://github.com/tom-23/farmcontrol-printhost.git
npm install
```

## Configuration

Create a .env file in the root directory of the project and provide the following content:

```
LOG_LEVEL=info
JWT_SECRET="<YOUR SECRET>"
TCP_SERVER_PORT=9000
WS_SERVER_ADDRESS="<http(s)://xxx.xxx.xxx.xxx:xxxx>"
REST_SERVER_ADDRESS="<http(s)://xxx.xxx.xxx.xxx:xxxx>"
```

## Running

Start via npm:
```
npm start
```
