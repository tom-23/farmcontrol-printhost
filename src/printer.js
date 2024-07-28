const log4js = require("log4js");
const config = require("../config.json");
const GCODE = require("./gcode").GCODE;
const { spawn } = require("child_process");

const logger = log4js.getLogger("Printer");
logger.level = config.logLevel;

const avrLogger = log4js.getLogger("AVRDude");
avrLogger.level = config.logLevel;

class Printer {
  constructor(remoteAddress, sendCallback, webSocketClient) {
    this.sendCallback = sendCallback;
    this.remoteAddress = remoteAddress;
    this.gcode = new GCODE();
    
    this.currentGCode = [];
    this.currentGCodePosition = 0;
    this.currentGCodePercent = 0;
    
    this.webSocketClient = webSocketClient;

    this.flashing = false;

    this.buffer = "";
    this.splitBuffer = "";
    this.commandQueue = [];

    this.temperatures = {
      hotEnd: { current: 0, target: 0 },
      heatedBed: { current: 0, target: 0 },
      at: 0,
      bt: 0,
    };

    this.firmwareInfo = [];

    this.avrDudeSocket = null;
    this.avrDudeProcess = null;
    this.avrDudeSocketDataQueue;

    this.isInitializing = false;
    this.isPrinting = false;
    this.isResending = false;
    this.resendLineNumber = 0;
    this.isProcessingCommand = false;
    this.isPrusa = true;
  }

  send(data) {
    this.commandQueue.push(data);
    if (this.isProcessingCommand == false) {
      this.isProcessingCommand = true;
      this.sendCallback(this.commandQueue.at(0));
    }
  }

  handleLine(line) {
    if (line == "") {
      return;
    }
    logger.trace("Processing: " + line);
    if ((line == "ok" || (this.isPrinting == true && (line == "o" || line == "k")) ) && config.useAck == true) {
      if (this.isResending == false && this.isPrinting == false) {
        this.commandQueue.splice(0, 1);
        if (this.commandQueue.length > 0) {
          this.isProcessingCommand = true;
          logger.trace("Processing next in command queue...");
          this.sendCallback(this.commandQueue.at(0));
        } else {
          logger.trace("No more to process.");
          this.isProcessingCommand = false;
        }
      } else if (this.isResending == false && this.isPrinting == true) {
        logger.trace("Processing line: " + this.currentGCodePosition + "...");
        this.sendCallback(this.currentGCode[this.currentGCodePosition]);
        const newPerc = (this.currentGCodePosition / this.currentGCode.length) * 100;
        
        console.log(newPerc + "%")
        if (Math.round(this.currentGCodePercent) != Math.round(newPerc)) {
          this.webSocketClient.sendStatus(this, { type: "Printing", percent: Math.round(this.currentGCodePercent) })
        }
        
        this.currentGCodePercent = newPerc;
        this.currentGCodePosition += 1;
        
      } else if (this.isResending == true && this.isPrinting == true) {
        logger.info("Resending GCode Line Number:", this.resendLineNumber);
        this.isResending = false;

        this.sendCallback(this.currentGCode[this.resendLineNumber]);
      } else {
        this.isProcessingCommand = true;
        logger.info("Resending last command...");
        this.isResending = false;
        this.sendCallback(this.commandQueue.at(0));
      }
    }

    if (line.startsWith("Resend")) {
      this.resendLineNumber = Number(line.split(": ")[1]);
      this.isResending = true;
    }

    if (line == "start" && this.isInitializing == false) {
      this.isInitializing = true;
      this.webSocketClient.sendStatus(this, { type: "Initializing" })
      logger.info("Recieved start command from printer. Waiting 5 seconds for initialization...");
      setTimeout(() => {
        this.initPrinter();
      }, 5000);
    }

    if (line == "initilized") {
      this.isInitializing = false;
      this.webSocketClient.sendStatus(this, { type: "Idle" })
      logger.info("Finished initialization. Printer is now ready.");
    }

    try {
      const parsedline = this.gcode.parseTemperatureStatus(line);
      this.temperatures = parsedline;
      this.webSocketClient.sendTemperatureUpdate(
        this.remoteAddress,
        this.temperatures
      );
    } catch (error) {}
    try {
      // Parse the firmware info string
      const parsedFirmwareInfo = this.gcode.parseFirmwareInfo(
        line,
        this.firmwareInfo
      );
      this.firmwareInfo = parsedFirmwareInfo;
    } catch (error) {}
  }

  handleData(socket, data) {
    if (this.flashing || this.avrDudeSocket !== null) {
      try {
        this.avrDudeSocket.write(data);
        logger.info("Forwarded:", data.toString("hex"), "to AVR Dude.");
      } catch (error) {
        logger.info("AVR hasn't connected yet. Storing data for later.");
        this.avrDudeSocketDataQueue = data;
      }
      return;
    }
    // Append new data to the buffer
    this.buffer += data.toString();
    
    logger.trace(
      `Received data from ${socket.remoteAddress}:${socket.remotePort}`
    );

    if (this.buffer.includes("\n")) {
      // Split the this.buffer by newline characters to process each line
      const lines = this.buffer.split("\n"); 
      // Process each complete line
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.length == 1) {
          if (this.splitBuffer == "") {
            this.splitBuffer += line;
          } else {
            this.handleLine(this.splitBuffer + line);
          }
        } else {
          this.handleLine(line);
        }
      }
    } else {
      // in some cases, marlin won't send a new line.
      logger.warn("Processing data dispite no new line being found.");
      this.handleLine(this.buffer);
    }
    // Clear this.buffer for next data
    this.buffer = "";
  }

  initPrinter() {
    logger.info("Initilizing printer...");
    this.commandQueue = [];
    this.isProcessingCommand = false;
    this.send(this.gcode.resetLineNumber());
    this.send(this.gcode.firmwareInfo());
    this.send(this.gcode.hostKeepAlive(3));
    this.send(this.gcode.temperatureAutoReport(1));
    this.send(this.gcode.setLCDMessage("IP: " + this.remoteAddress));
    this.send(this.gcode.echo("initilized"));
  }

  restartPrinter() {
    this.send(this.gcode.stopRestart());
  }

  homeAxis(axis) {
    this.send(this.gcode.homeAxis(axis));
  }

  flashAVR(hexFilePath) {
    const avrdudeArgs = [
      "-v", // Verbose output
      "-p",
      "atmega2560", // Specify the AVR microcontroller
      "-c",
      "wiring", // Specify the programmer type
      "-P",
      "net:localhost:9000", // Specify the port or network address
      "-D", // Disable auto erase for flash memory
      "-U",
      `flash:w:${hexFilePath}:i`, // Specify the flash operation
    ];

    this.avrDudeProcess = spawn("avrdude", avrdudeArgs);

    var buffer = "";

    this.avrDudeProcess.stdout.on("data", (data) => {
      // Append new data to the buffer
      buffer += data.toString();

      if (buffer.endsWith("\n")) {
        // Split the buffer by newline characters to process each line
        let lines = buffer.split("\n");

        // Process each complete line
        while (lines.length > 1) {
          let line = lines.shift().trim();
          avrLogger.info(line); // Log stdout data
        }
      }
    });

    this.avrDudeProcess.on("close", (code) => {
      if (code === 0) {
        avrLogger.log("avrdude command executed successfully");
      } else {
        avrLogger.error(`avrdude command failed with code ${code}`);
      }
      this.flashing = false;
    });

    this.avrDudeProcess.on("error", (err) => {
      avrLogger.error(`Failed to execute avrdude command: ${err}`);
      this.flashing = false;
    });
  }

  resetPrinter() {
    logger.info("Resetting printer...");
    this.send("PRUSA RESET");
  }

  firmwareUpdate() {
    logger.info("Starting avrdude...");
    this.flashAVR(
      "/Users/tombutcher/Downloads/MK3S_MK3S+_FW_3.14.0_MULTILANG (1).hex"
    );
    this.flashing = true;
    setTimeout(() => {
      this.resetPrinter();
    }, 100);
  }

  setAvrDudeSocket(avrDudeSocket) {
    this.avrDudeSocket = avrDudeSocket;
    //this.avrDudeSocket.write(this.avrDudeSocketDataQueue);
  }

  setTemperature(target, value) {
    if (target == "hotEnd") {
      this.send(this.gcode.setHotEndTemerature(value));
    } else if (target == "heatedBed") {
      this.send(this.gcode.setBedTemerature(value));
    }
  }

  moveAxis(axis, pos, rate) {
    this.send(this.gcode.relativePositioning());
    this.send(this.gcode.moveAxis(axis, pos, rate));
    this.send(this.gcode.absolutePositioning());
  }

  startPrint(gcode) {
    logger.info("Starting print...");
    this.webSocketClient.sendStatus(this, { type: "Printing", percent: Math.round(this.currentGCodePercent) })
    this.currentGCode = [];
    this.isPrinting = true;
    //this.send(this.gcode.temperatureAutoReport(0));
    const lines = this.gcode.print(gcode, false).split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      this.currentGCode.push(line);
    }
    this.send(this.currentGCode[0]);
  }
}

module.exports = { Printer };
