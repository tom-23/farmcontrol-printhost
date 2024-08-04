import log4js from 'log4js';
import GCode from './GCode.js';
import { spawn } from 'child_process';
import { threadId } from 'worker_threads';
import rawListeners from 'process';
import dotenv from 'dotenv';
import axios from 'axios';
import jwt from 'jsonwebtoken';

dotenv.config();

const logger = log4js.getLogger("Printer");
logger.level = process.env.LOG_LEVEL;


const avrLogger = log4js.getLogger("AVRDude");
avrLogger.level = process.env.LOG_LEVEL;

export default class Printer {
  constructor(socket, tcpServer) {
    this.socket = socket;
    this.remoteAddress = this.socket.remoteAddress;
    this.tcpServer = tcpServer;
    this.webSocketClient = this.tcpServer.webSocketClient;
    this.gcode = new GCode();

    this.currentGCode = [];
    this.currentGCodeFileName = "";
    this.currentGCodeFileId = "";
    this.currentGCodePosition = 0;
    this.currentGCodePercent = 0;
    this.currentGCodeAlive = false;

    this.percent = 0;

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

    this.temperatureInterval = 1;

    this.firmwareInfo = [];

    this.avrDudeSocket = null;
    this.avrDudeProcess = null;
    this.avrDudeSocketDataQueue;

    this.isInitializing = false;
    this.isProcessingGCode = false;
    this.isResending = false;
    this.resendLineNumber = 0;
    this.isProcessingCommand = false;
    this.isListingFiles = false;
    this.isPrusa = true;

    this.status = "Offline";
    this.fileList = [];

    this.uploadList = [];
    this.deleteList = [];

    this.heartBeat = false;

    this.heartBeatInterval = setInterval(() => {
      if (!this.flashing) {
        if (this.heartBeat == true) {
          logger.trace("Connection heartbeat.");
          this.heartBeat = false;
        } else {
          logger.warn("It looks like the printer is offline. Marking as disconnected...");
          this.disconnect();
        }
      }
    }, 5000)

    this.gcodeWriteInterval = setInterval(() => {
      if (this.isProcessingGCode == true) {
        if (this.currentGCodeAlive == true) {
          this.currentGCodeAlive = false;
        } else { // if we have stopped for some reason, resend last command.
          logger.warn("Processing line as command queue stopped processing - Number: " + this.currentGCodePosition + " " + this.currentGCode[this.currentGCodePosition]);
          this.socket.write(this.currentGCode[this.currentGCodePosition] + "\n");
        }
      }
    }, 500)

    this.deployInterval = setInterval(() => {
      if (!this.flashing && this.status == "Idle") {
        this.listSDCard();
      }
    }, 30000)

  }

  disconnect() {
    clearInterval(this.heartBeatInterval);
    this.heartBeat = false;
    this.status = "Offline"
  }

  send(data) {
    this.commandQueue.push(data);
    if (this.isProcessingCommand == false) {
      this.isProcessingCommand = true;
      this.socket.write(this.commandQueue.at(0) + "\n");
    }
  }

  handleLine(line) {
    if (line == "") {
      return;
    }

    this.heartBeat = true;
    if (this.status == "Offline") {
      this.resetPrinter();
    }
    logger.trace("Processing: " + line);
    if (line == "ok" || (this.isProcessingGCode == true && (line == "o" || line == "k" || line == "kk" || line == "ko"))) {
      this.currentGCodeAlive = true;
      if (this.isResending == false && this.isProcessingGCode == false) {
        this.commandQueue.splice(0, 1);
        if (this.commandQueue.length > 0) {
          this.isProcessingCommand = true;
          logger.trace("Processing next in command queue...");
          this.socket.write(this.commandQueue.at(0) + "\n");
        } else {
          logger.trace("No more to process.");
          this.isProcessingCommand = false;
        }
      } else if (this.isResending == false && this.isProcessingGCode == true) { // Process next line in code

        if (this.currentGCodePosition == this.currentGCode.length) { // Once processing has finished...
          this.isProcessingGCode = false;
          this.isProcessingCommand = false;
          this.currentGCodePosition = 0;
          this.currentGCodePercent = 0;
          this.send(this.gcode.stopSDWrite());
          logger.trace("GCode processing finished on line: " + this.currentGCodePosition);
          this.webSocketClient.sendAlert(this, { type: "Print Finished" });

        } else {
          logger.trace("Processing line - Number: " + this.currentGCodePosition + " " + this.currentGCode[this.currentGCodePosition]);
          this.socket.write(this.currentGCode[this.currentGCodePosition] + "\n");
          const newPerc = (this.currentGCodePosition / this.currentGCode.length) * 100;

          if (Math.round(this.currentGCodePercent) != Math.round(newPerc)) {
            logger.info(this.status + "... " + Math.round(this.currentGCodePercent))
            this.percent = Math.round(this.currentGCodePercent);
            this.webSocketClient.sendStatus(this)
          }

          this.currentGCodePercent = newPerc;
          this.currentGCodePosition += 1;
        }


      } else if (this.isResending == true && this.isProcessingGCode == true) {
        logger.info("Resending GCode Line Number:", this.resendLineNumber);
        this.isResending = false;
        this.socket.write(this.currentGCode[this.resendLineNumber] + "\n");
        this.currentGCodePosition = this.resendLineNumber + 1;
      } else {
        this.isProcessingCommand = true;
        logger.info("Resending last command...");
        this.isResending = false;
        this.socket.write(this.commandQueue.at(0) + "\n");
      }
    }

    if (line.startsWith("Resend")) {
      this.resendLineNumber = Number(line.split(": ")[1]);
      this.isResending = true;
    }

    if (line == "Done saving file.") {
      this.isProcessingGCode = false;
      this.isProcessingCommand = false;
      this.currentGCodePosition = 0;
      this.currentGCodePercent = 0;
      this.currentGCode = [];
      setTimeout(() => {
        this.send(this.gcode.resetLineNumber());
      }, 500)
      logger.trace("GCode processing finished on line: " + this.currentGCodePosition);
      this.webSocketClient.sendAlert(this, { type: "Finished uploading " + this.currentGCodeFileName + "." });
      if (this.uploadList.length > 0) {
        this.uploadList.shift();
        if (this.uploadList.length != 0) {
          this.currentGCodeFileId = this.uploadList[0].gcodeFileId;
          this.currentGCodeFileName = this.uploadList[0].gcodeFileName;
          this.writeToSD(this.uploadList[0].gcode, this.uploadList[0].gcodeFileName)
          return;
        }
      }
      this.status = "Idle"
      this.webSocketClient.sendStatus(this)
    }

    if (line.startsWith("NORMAL MODE: ")) {
      const values = line.replace("NORMAL MODE: ").split("; ");
      this.status = "Printing";
      this.webSocketClient.sendStatus(this, { type: this.status, percent: Number(values[0].split(": ")[1]), timeRemaining: Number(values[1].split(": ")[1]) })
    }

    if (line == "start" && this.isInitializing == false) {
      this.isInitializing = true;
      this.status = "Initializing";
      this.webSocketClient.sendStatus(this, { type: this.status })
      logger.info("Recieved start command from printer. Waiting 5 seconds for initialization...");
      setTimeout(() => {
        this.initPrinter();
      }, 5000);
    }

    if (line == "initilized") {
      this.isInitializing = false;
      this.status = "Idle";
      this.webSocketClient.sendStatus(this, { type: this.status })
      logger.info("Finished initialization. Printer is now ready.");
    }

    if (line == "End file list") {
      this.isListingFiles = false;
      this.webSocketClient.sendFileList(this, this.fileList);
    }

    if (this.isListingFiles == true) {
      const lineSplit = line.split(" ");
      const newFile = {
        gcodeFileName: lineSplit[0].toLowerCase(),
        size: lineSplit[1]
      }
      if (newFile.gcodeFileName.endsWith('.g')) {
        this.fileList.push(newFile);
      }
    }

    if (line == "Begin file list") {
      this.fileList = [];
      this.isListingFiles = true;
    }



    try {
      const parsedline = this.gcode.parseTemperatureStatus(line);
      this.temperatures = parsedline;
      this.webSocketClient.sendTemperatureUpdate(
        this.remoteAddress,
        this.temperatures
      );
    } catch (error) { }
    try {
      // Parse the firmware info string
      const parsedFirmwareInfo = this.gcode.parseFirmwareInfo(
        line,
        this.firmwareInfo
      );
      this.firmwareInfo = parsedFirmwareInfo;
    } catch (error) { }
  }

  handleData(data) {
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
      "Received data: " + data
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
    this.send(this.gcode.temperatureAutoReport(this.temperatureInterval));
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

  levelBed() {
    this.send(this.gcode.bedLeveling());
  }

  changeFillament() {
    this.send(this.gcode.fillamentChange());
  }

  startPrint(gcode) {
    logger.info("Starting print...");
    this.status = "Printing"
    this.webSocketClient.sendStatus(this, { type: this.status, percent: Math.round(this.currentGCodePercent) })
    this.send(this.gcode.resetLineNumber());
    this.currentGCode = [];
    this.isProcessingGCode = true;
    //this.send(this.gcode.temperatureAutoReport(0));
    const lines = this.gcode.formatGCode(gcode, false).split("\n");
    logger.info("Line count: ", lines.length);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      this.currentGCode.push(line);
    }
    this.send(this.currentGCode[0]);
  }

  writeToSD(gcode, filename) {
    logger.info("Writing", filename, "to SD card...");
    this.status = "Uploading"
    this.webSocketClient.sendStatus(this, { type: this.status, percent: Math.round(this.currentGCodePercent) });
    this.currentGCode = [];
    this.currentGCodePosition = 0;
    this.currentGCodePercent = 0;
    const lines = this.gcode.writeToSD(gcode, filename).split("\n");
    logger.info("Line count: ", lines.length);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      this.currentGCode.push(line);
    }
    this.isProcessingGCode = true;
    this.send(this.currentGCode[0]);
  }

  listSDCard() {
    this.socket.write(this.gcode.listSDCard() + "\n");
  }

  deleteSDFile(filename) {
    this.socket.write(this.gcode.deleteSDFile(filename) + "\n");
  }

  async getGCodeFile(id) {
    try {
      logger.info("Downloading GCode file: " + id);
      const response = await axios.get(process.env.REST_SERVER_ADDRESS + "/gcodefiles/" + id + "/content", {
        responseType: 'text',
        headers: {
          Authorization: `Bearer ${this.webSocketClient.token}`,
        }
      });
      logger.info("Finished downloading GCode file: " + id);
      return response.data;
    } catch (error) {
      logger.error('Error downloading the file:', error);
      throw error;
    }
  }
  async deploy(manifest) {
    if (this.status != "Idle") {
      return;
    }

    logger.info("Deploying manifest...");

    this.status = "Processing";

    this.webSocketClient.sendStatus(this, { type: this.status });

    const deleteActions = manifest.filter((item) => item.action == "delete");
    const uploadActions = manifest.filter((item) => item.action == "upload");

    logger.info(deleteActions.length + " file(s) to be deleted.")
    for (let i = 0; i < deleteActions.length; i++) {
      const action = deleteActions[i];
      logger.info("Deleting " + action.gcodeFileName + "...")
      this.deleteList.push({
        gcodeFileName: action.gcodeFileName
      })
      this.deleteSDFile(action.gcodeFileName);
    }

    for (let i = 0; i < uploadActions.length; i++) {
      const action = uploadActions[i];
      const gcode = await this.getGCodeFile(action.id);
      this.uploadList.push({
        gcodeFileId: action.id,
        gcodeFileName: action.gcodeFileName,
        gcode
      })
    }

    setTimeout(() => {
      logger.info(uploadActions.length + " file(s) to be uploaded.")
      if (this.uploadList.length != 0) {
        this.currentGCodeFileId = this.uploadList[0].gcodeFileId;
        this.currentGCodeFileName = this.uploadList[0].gcodeFileName;
        this.writeToSD(this.uploadList[0].gcode, this.uploadList[0].gcodeFileName)
      } else {
        this.status = "Idle";
        this.webSocketClient.sendStatus(this, { type: this.status });
      }
    }, 1500)

  }
}