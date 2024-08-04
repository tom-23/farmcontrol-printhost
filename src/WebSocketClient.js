import log4js from 'log4js';
import io from 'socket.io-client';
import jwt from 'jsonwebtoken';
import os from 'node:os';
import dotenv from 'dotenv';

dotenv.config();

const logger = log4js.getLogger("Web Sockets");
logger.level = process.env.LOG_LEVEL;

const hostId = os.hostname();

export default class WebSocketClient {
  constructor(connectionUrl) {
    this.connectionUrl = connectionUrl;
    this.token = jwt.sign({ hostId: hostId }, process.env.JWT_SECRET);
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
          logger.info("Sending onine status for", printer.remoteAddress);
          this.sendStatus(printer);
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

    this.socket.on("levelBed", (data) => {
      this.tcpServer.getPrinter(data.remoteAddress).levelBed();
    });

    this.socket.on("changeFillament", (data) => {
      this.tcpServer.getPrinter(data.remoteAddress).changeFillament();
    });

    this.socket.on("firmwareUpdate", (data) => {
      this.tcpServer.getPrinter(data.remoteAddress).firmwareUpdate();
    });

    this.socket.on("print", (data) => {
      this.tcpServer.getPrinter(data.remoteAddress).startPrint(data.data.gcode);
    });

    this.socket.on("writeToSD", (data) => {
      this.tcpServer.getPrinter(data.remoteAddress).writeToSD(data.data.gcode, data.data.filename);
    });

    this.socket.on("deploy", (data) => {
      this.tcpServer.getPrinter(data.remoteAddress).deploy(data.manifest);
    });
  }

  sendStatus(printer, cb) {
    logger.info("Sending '" + printer.status + "' status message...")
    const statusData = {
      type: 'printer',
      status: { type: printer.status, percent: printer.percent },
      hostId,
      remoteAddress: printer.remoteAddress
    }
    this.socket.emit("status", statusData, cb)
  }

  sendAlert(printer, data, cb) {
    logger.info("Sending '" + data.type + "' alert message...")
    const alertData = {
      type: 'printer',
      alert: data,
      hostId,
      remoteAddress: printer.remoteAddress
    }
    this.socket.emit("alert", alertData, cb)
  }

  sendFileList(printer, fileList, cb) {
    logger.info("Sending list of " + fileList.length + " file(s)...")
    const fileListData = {
      type: 'printer',
      fileList,
      hostId,
      remoteAddress: printer.remoteAddress
    }
    this.socket.emit("fileList", fileListData, cb)
  }

  sendTemperatureUpdate(remoteAddress, temperatures, cb) {
    if (!this.socket.connected) {
      logger.error("Not connected.")
      return;
    }
    const data = {
      remoteAddress,
      temperatures
    }
    this.socket.emit("temperature", data, cb);
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
