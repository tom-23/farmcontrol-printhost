export default class GCode {
  constructor() {
    this.lineNumber = 0;
  }
  getChecksum(command) {
    let strippedCommand = command.trim().replace(/^\$|(\*.*)$/g, "");

    let checksum = 0x00;

    for (let i = 0; i < strippedCommand.length; i++) {
      checksum ^= strippedCommand.charCodeAt(i);
    }

    return "*" + checksum;
  }
  calculateMarlinChecksum(lineNumber, command, params = "") {
    // Remove the initial '$' and any '*' character and checksum bytes
    let strippedCommand =
      "N" + lineNumber + command.trim().replace(/^\$|(\*.*)$/g, "") + params;

    // Calculate the XOR checksum
    const checksum = strippedCommand
      .split("")
      .map((c) => c.charCodeAt(0))
      .reduce((x, y) => x ^ y, 0);

    return `N${lineNumber} ${command} ${params}*${checksum}`;
  }

  format(comand, params) {
    this.lineNumber = this.lineNumber + 1;
    return this.calculateMarlinChecksum(this.lineNumber - 1, comand, params);
  }

  resetLineNumber() {
    this.lineNumber = 1;
    return "M110 N0";
  }

  temperatureAutoReport(seconds) {
    return this.format("M155 S" + seconds);
  }

  reportTemperatures() {
    return this.format("M105");
  }

  setLCDMessage(message) {
    return this.format("M117 " + message);
  }

  firmwareInfo() {
    return this.format("M115");
  }

  endstopStates() {
    return this.format("M119");
  }

  hostKeepAlive(seconds) {
    return this.format("M113 S" + seconds);
  }

  setBedTemerature(targetTemperature) {
    return this.format("M140 S" + targetTemperature);
  }

  setHotEndTemerature(targetTemperature, index) {
    return this.format("M104 S" + targetTemperature);
  }

  stopRestart() {
    return this.format("PRUSA RESET")
  }

  homeAxis(axis) {
    if (axis == "ALL") { axis = " W" }
    if (axis == " XY" || axis == " YX") { axis = " X Y" }
    return this.format("G28" + axis);
  }

  absolutePositioning() {
    return this.format("G90")
  }

  relativePositioning() {
    return this.format("G91")
  }

  bedLeveling() {
    return this.format("G80")
  }

  fillamentChange() {
    return this.format("M600")
  }

  startSDWrite(filename) {
    return this.format("M28", "/" + filename)
  }

  stopSDWrite() {
    return this.format("M29")
  }

  moveAxis(axis, pos, rate = 100) {
    return this.format("G1 " + axis + pos + " F" + rate);
  }

  parseTemperatureStatus(statusString) {
    // Regular expression to match the updated pattern
    const regex =
      /^T:(\d+\.\d+) \/(\d+\.\d+) B:(\d+\.\d+) \/(\d+\.\d+) T0:(\d+\.\d+) \/(\d+\.\d+) @:(\d+) B@:(\d+) P:(\d+\.\d+) A:(\d+\.\d+)$/;

    // Execute the regex on the statusString
    const match = regex.exec(statusString);

    if (!match) {
      throw new Error("Invalid status string format");
    }

    // Extracting matched groups from the regex
    const parsedData = {
      hotEnd: {
        current: parseFloat(match[1]),
        target: parseFloat(match[2]),
      },
      heatedBed: {
        current: parseFloat(match[3]),
        target: parseFloat(match[4]),
      },
      hotEndT0: {
        current: parseFloat(match[5]),
        target: parseFloat(match[6]),
      },
      hotendPower: parseInt(match[7]),
      bedPower: parseInt(match[8]),
      pindaTemp: parseFloat(match[9]),
      ambiantActual: parseFloat(match[10]),
    };

    return parsedData;
  }

  parseFirmwareDetails(firmwareDetailsString) {
    const firmwareInfo = {};
    const keyValuePairs = firmwareDetailsString.match(/([A-Z_]+:[^ ]+)/g);

    keyValuePairs.forEach((pair) => {
      const [key, value] = pair.split(/:(.+)/);
      firmwareInfo[key] = value;
    });

    return firmwareInfo;
  }

  parseFirmwareInfo(firmwareInfoString, firmwareInfo) {
    const lines = firmwareInfoString.trim().split("\n");

    lines.forEach((line) => {
      let match = /^Cap:([A-Z_]+):(\d)$/.exec(line.trim());
      if (match) {
        const key = match[1];
        const value = parseInt(match[2]) === 1;
        firmwareInfo[key] = value;
      } else {
        // Check if the line contains multiple key-value pairs
        match = line.match(/FIRMWARE_NAME:/);
        if (match) {
          // Parse the line using parseFirmwareDetails
          const details = parseFirmwareDetails(line.trim());
          Object.assign(firmwareInfo, details);
        } else {
          throw new Error(`Invalid line format: ${line}`);
        }
      }
    });

    return firmwareInfo;
  }

  writeToSD(gcode, filename) {
    var output = "";
    output += this.resetLineNumber() + "\n";
    output += this.startSDWrite(filename) + "\n";
    const lines = gcode.split('\n');

    for (let i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line != "" && !line.startsWith(";")) {
        if (line.includes(";")) {
          const lineSplit = line.split(';');
          line = lineSplit[0];
          line = line.replace("\n", "").replace(" ", "").trim();
        }
        output += this.format(line) + "\n";
      }
    }

    output += this.stopSDWrite();

    return output;
  }

  listSDCard() {
    return this.format("M20 L");
  }

  deleteSDFile(filename) {
    return this.format("M30", "/" + filename);
  }

  echo(message) {
    return this.format("M118 " + message);
  }
}
