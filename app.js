import log4js from 'log4js';
import WebSocketClient from './src/WebSocketClient.js';
import TCPServer from './src/TCPServer.js';
import dns from 'node:dns';
import os from 'node:os';
import dotenv from 'dotenv';

dotenv.config();

const logger = log4js.getLogger("App");
logger.level = process.env.LOG_LEVEL;

function showSystemInfo() {
  logger.info("=== System Info ===")
  logger.info("Hostname:", os.hostname());
  const networkInterfaces = os.networkInterfaces();
  logger.info("Interfaces:", networkInterfaces);
  logger.info("Memory:", Math.round(os.totalmem() / 1024 / 1024) + "mb");
  console.log("");
}

showSystemInfo();
logger.info("Print Host Starting...");

var client = new WebSocketClient(process.env.WS_SERVER_ADDRESS);
var server = new TCPServer("0.0.0.0", process.env.TCP_SERVER_PORT, client);
client.start();
server.start();