const log4js = require("log4js");
const WebSocketClient = require("./src/client.js").WebSocketClient;
const TCPServer = require("./src/server.js").TCPServer;

const os = require("os");
const config = require("./config.json");

const logger = log4js.getLogger("App");
logger.level = config.logLevel;

function showSystemInfo() {
  logger.info("=== System Info ===")
  logger.info("Hostname:", os.hostname());
  logger.info("Memory:", os.totalmem() / 1024 / 1024 + "mb");
  console.log("");
}

showSystemInfo();
logger.info("Print Host Starting...");

var client = new WebSocketClient("http://localhost:5050");
var server = new TCPServer("0.0.0.0", 9000, client);
client.start();
server.start();