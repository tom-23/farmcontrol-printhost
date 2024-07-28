const log4js = require("log4js");
const io = require("socket.io-client");
const jwt = require('jsonwebtoken');
const os = require("os");
const config = require("../config.json");

const logger = log4js.getLogger("Web Sockets");
logger.level = config.logLevel;

const hostId = os.hostname();

class WebSocketClient {
  constructor(connectionUrl) {
    this.connectionUrl = connectionUrl;
    this.token = jwt.sign({ hostId: hostId }, config.jwt_secret);
  }

  setTCPServer(tcpServer) {
    this.tcpServer = tcpServer;
  }

  initHandlers() {
    this.socket.on("connect", (socket) => {
      logger.info("WebSocket connected.");
      if (this.tcpServer !== undefined) {
        for (let i = 0; i < this.tcpServer.printers.length; i++) {
          const printer = this.tcpServer.printers[i];
          console.log("Sending onine status for", printer.remoteAddress);
          this.sendOnline(printer);
        }
      }
    });
    this.socket.on("connect_error", (error) => {
      logger.error("Connection Error!");
      logger.error("Error Type:", error.type);
      logger.error("Error Message:", error.message);
    });
    this.socket.on("reconnect_attempt", () => {
      logger.warn("Attempting to recconnect...");
    });
    this.socket.on("reconnect_failed", () => {
      logger.error("Recconnect failed.");
    });
    this.socket.on("reconnect_error", (error) => {
      logger.error("Reconnect Error!");
      logger.error("Error Type:", error.type);
      logger.error("Error Message:", error.message);
    });
    this.socket.on("error", (error) => {
      logger.error("WebSocket Error!");
      logger.error("Error Type:", error.type);
      logger.error("Error Message:", error.message);
    });
    this.socket.on("disconnect", () => {
      logger.info("WebSocket disconnected.");
    });

    this.socket.on("homeAxis", (data) => {
      this.tcpServer.getPrinter(data.remoteAddress).homeAxis(data.data.axis)
    });

    this.socket.on("setTemperature", (data) => {
      this.tcpServer.getPrinter(data.remoteAddress).setTemperature(data.data.target, data.data.value)
    });

    this.socket.on("moveAxis", (data) => {
      const { axis, pos, rate } = data.data;
      this.tcpServer.getPrinter(data.remoteAddress).moveAxis(axis, pos, rate);
    });

    this.socket.on("firmwareUpdate", (data) => {
      this.tcpServer.getPrinter(data.remoteAddress).firmwareUpdate();
    });

    this.socket.on("writeToSD", (data) => {
      this.tcpServer.getPrinter(data.remoteAddress).startPrint(data.data.gcode);
    });
  }
  
  sendOnline(printer) {
    logger.info("Sending online message...")
    const data = {
      type: 'printer',
      hostId,
      remoteAddress: printer.remoteAddress
    }
    this.socket.emit("online", data)
  }

  sendStatus(printer, data) {
    logger.info("Sending '" + data.type + "' status message...")
    const statusData = {
      type: 'printer',
      status: data,
      hostId,
      remoteAddress: printer.remoteAddress
    }
    this.socket.emit("status", statusData)
  }

  sendOffline(printer) {
    logger.info("Sending offline message...")
    const data = {
      type: 'printer',
      hostId,
      remoteAddress: printer.remoteAddress
    }
    this.socket.emit("offline", data)
  }

  sendTemperatureUpdate(remoteAddress, temperatures) {
    if (!this.socket.connected) {
      logger.error("Not connected.")
      return;
    }
    const data = {
      remoteAddress,
      temperatures
    }
    this.socket.emit("temperature", data);
  }

  start() {
    this.socket = io.connect(this.connectionUrl, {
      reconnect: true,
      reconnectionDelay: 5000,
      query: { token: this.token }
    });
    this.initHandlers();
  }
}

module.exports = { WebSocketClient };
