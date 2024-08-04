import log4js from 'log4js';
import Printer from './Printer.js';
import GCode from './GCode.js';
import net from 'net';
import { request } from 'http';
import dotenv from 'dotenv';

dotenv.config();

const logger = log4js.getLogger("TCP Server");
logger.level = process.env.LOG_LEVEL;

var newPrinter;

export default class TCPServer {
  constructor(host, port, webSocketClient) {
    this.host = host;
    this.port = port;
    this.webSocketClient = webSocketClient;
    this.webSocketClient.setTCPServer(this);
    this.clients = [];
    this.printers = [];
    this.server = net.createServer(this.handleConnection.bind(this));
  }

  handleConnection(socket) {
    // Add the new client socket to the clients array
    if (
      socket.remoteAddress.includes("127.0.0.1") ||
      socket.remoteAddress.includes("localhost")
    ) {
      logger.info("AVR Dude connected.");
      const firmwareUpdatePrinter = this.getFirmwareUpdatePrinter()
      firmwareUpdatePrinter.setAvrDudeSocket(socket);

      const firmwareUpdatePrinterSocket = this.getSocket(firmwareUpdatePrinter.remoteAddress)

      socket.on("data", (data) => {
        logger.info("Sending AVR Socket data to", firmwareUpdatePrinterSocket.remoteAddress);
        logger.trace("Data", data.toString('hex'));
        firmwareUpdatePrinterSocket.write(data);
      });
      return;
    }
    this.clients.push(socket);
    logger.info(
      `Client connected from ${socket.remoteAddress}:${socket.remotePort}`
    );
    logger.info(`Local address: ${socket.localAddress}:${socket.localPort}`);

    newPrinter = new Printer(socket, this);

    this.firmwareUploadPrinter = newPrinter;
    this.printers.push(newPrinter);

    // Handle incoming data from clients
    socket.on("data", (data) => {
      this.getPrinter(socket.remoteAddress).handleData(data);
    });

    // Handle errors
    socket.on("error", (err) => {
      this.handleError(err);
    });
  }

  handleError(err) {
    console.error(`Error: ${err.message}`);
  }

  getPrinter(remoteAddress) {
    return this.printers.find(
      (printer) => printer.remoteAddress === remoteAddress
    );
  }

  getFirmwareUpdatePrinter() {
    return this.printers.find(printer => printer.flashing);
  }

  getSocket(remoteAddress) {
    return this.clients.find(
      (client) => client.remoteAddress === remoteAddress
    );
  }

  getPrinterById(id) {
    return this.printers.at(id);
  }

  start() {
    this.server.listen(this.port, this.host, () => {
      logger.info(`Server listening on ${this.host}:${this.port}`);
    });
  }
}