// ----------------------------------------------------------------------------
//  Copyright (C) Microsoft. All rights reserved.
//  Licensed under the MIT license.
// ----------------------------------------------------------------------------

const colors = require('colors');
const fs = require('fs');
const path = require('path');

exports.detectProject = function(compile_path, runCmd, command) {
  var detected = null;
  if (fs.existsSync(path.join(compile_path, '.mbed')) || fs.existsSync(path.join(compile_path, 'mbed_app.json')) ||
    fs.existsSync(path.join(compile_path, 'mbed-os.lib'))) {
    detected = {
      "toolchain": "mbed"
    };
  }

  var args = [];
  if (typeof runCmd === 'string' && runCmd.length) {
    args = runCmd.split(' ');
  }

  if (!detected || args.length > 1) {
    if (!detected && (command == "mbed" || args[0] == "mbed")) {
      detected = {
        "toolchain": "mbed"
      };
    }

    if (detected && args.length > 1) {
      detected.target = args[1]; // deviceId
    }
  }

  return detected;
}

exports.selfCall = function(config, runCmd, command, compile_path) {
  if (runCmd !== -1) {
    runCmd = command + " " + runCmd;
  } else {
    runCmd = command;
  }
  return runCmd;
}

exports.createExtension = function() {
  return {
    run :`
      RUN echo -e " - installing ARM mbed tools"

      RUN pip install mbed-cli \
        && mkdir XXX && cd XXX && echo "#include <mbed.h>\\nint main(){return 0;}" > main.cpp \
        && mbed new . && mbed compile -t GCC_ARM -m NUCLEO_L476RG \
        && cd .. && rm -rf XXX
      `,
    callback: null
  }
}

var checkSource = function checkSource(config) {
  var source = '';
  if (config.hasOwnProperty("mbed_app.json")) {
    var basejson = '';
    var mbedjsonFilePath = path.join(process.cwd(), 'iotz-mbed-deps', 'mbed_app.json');
    if (fs.existsSync(mbedjsonFilePath)) {
      basejson = fs.readFileSync(mbedjsonFilePath) + "";
    }

    var newjson = JSON.stringify(config["mbed_app.json"], 0, 2);
    if (basejson != newjson) {
      // update mbed_app.json
      fs.writeFileSync(mbedjsonFilePath, newjson);
    }
    source = '--app-config iotz-mbed-deps/mbed_app.json';
  }
  return source;
}

exports.buildCommands = function mbedBuild(config, runCmd, command, compile_path, mount_path) {
  var target_board = config.target;
  var runString = "";
  var callback = null;

  if (command == "localFolderContainerConstructer") {
    // noop
  } else if (command == "init") {
    if (typeof runCmd === 'string' && runCmd.length) {
      // don't let setting target board from multiple places
      var detected = exports.detectProject(compile_path, runCmd, command);
      if (config.target != detected.target) {
        if (target_board) {
          console.error(" -", colors.yellow('warning:'), 'updating the target board definition on iotz.json file.');
        }
        target = detected.target;
        target_board = config.target;
        try {
          fs.writeFileSync(path.join(compile_path, 'iotz.json'), JSON.stringify(config, 0, 2));
          console.log(' -', 'successfully updated target on iotz.json file');
        } catch (e) {
          console.error(' -', colors.red('error:'), "couldn't update iotz.json with the target board.");
          console.error('  ', e.message);
          console.error(' -', `"iotz compile" might fail. please add the \n "target":"${target_board}"\n on iotz.json file`);
        }
      }
    }

    var bslash = process.platform === "win32" ? "" : "\\";
    var libs = ` && mkdir -p iotz-mbed-deps && find . -type f -iname '*.lib' ! -iname 'mbed-os.lib' -exec cat {}\
 \\; | while read line; do cd iotz-mbed-deps && mbed add ${bslash}$line 2>/dev/null || cd .. && cd .. ; done\
 && if [ -d iotz-mbed-deps/mbed-os ]; then rm -rf mbed-os && mv iotz-mbed-deps/mbed-os .; fi`;
    if (config.deps) {
      for (let lib of config.deps) {
        if (lib) {
          if (!lib.url) {
            console.error(" -", colors.red("error :"),
              "Unknown config ", JSON.stringify(lib, 0, 2));
          } else {
            if (lib.url.indexOf(lib.name) == -1) {
              console.error(" -", colors.red('error :'), "library name is case sensitive.");
              console.error("   ", `${lib.name} should match the name in ${lib.url}`);
              process.exit(1);
            }
            if (lib.name != 'mbed-os') {
              libs += ` && rm -rf iotz-mbed-deps/${lib.name} && mbed add ${lib.url} iotz-mbed-deps/${lib.name}`;
            } else {
              libs += ` && rm -rf ${lib.name} && mbed add ${lib.url}`;
            }
          }
        }
      }
    }

    var importMbed = "";
    if (libs.indexOf("/mbed-os/#") > 0) {
      importMbed = "--create-only";
    }

    // if project seeks a specific version of MBED, import and use it instead
    libs = `mbed new . ${importMbed} --depth 1 && mbed target ${target_board} && mbed toolchain GCC_ARM` + libs;
    runString = exports.buildCommands(config, runCmd, 'clean').run + " && " + libs;

    callback = function(config) {
      if (config.hasOwnProperty("mbed_app.json")) {
        var mbedjsonFilePath = path.join(process.cwd(), 'iotz-mbed-deps', 'mbed_app.json');
        var newjson = JSON.stringify(config["mbed_app.json"], 0, 2);
        fs.writeFileSync(mbedjsonFilePath, newjson);
      }
    }

    if (!config.target) {
      runString += `\
 && mbed target -S && \
echo -e \
'${colors.yellow('you should define the "target" from the above.')}\
Please update ${colors.bold('iotz.json')} with "target".'
`;
    }
  } else if (command == "clean") {
    runString = "rm -rf iotz-mbed-deps/ BUILD/ .mbed mbed/ mbed-os.lib mbed-os/ mbed_settings.py*"
  } else if (command == 'compile') {
    var source = checkSource(config);
    runString = `mbed compile ${source}`;
  } else if (command == 'export') {
    var source = checkSource(config);
    runString = `mbed export --ide make_gcc_arm ${source}`;
    callback = function(config) {
      var mpath = path.join(process.cwd(), "Makefile");
      if (!fs.existsSync(mpath)) {
        console.error(" -", colors.red('error'), 'Unable to find Makefile on the current path');
        process.exit(1);
      }
      var source = fs.readFileSync(mpath) + "";
      source = source.replace("CPP     = 'arm-none-eabi-g++'",
        "CPP     = 'arm-none-eabi-g++' '-fdiagnostics-color=always'");
      source = source.replace("C     = 'arm-none-eabi-gcc'",
        "CC     = 'arm-none-eabi-gcc' '-fdiagnostics-color=always'");
      fs.writeFileSync(mpath, source);

      console.log(colors.green("Makefile"), "is ready.\nTry ",
        colors.bold('iotz make -j2'));
    }
  } else {
    console.error(" -", colors.red("error :"),
              "Unknown command", command);
    process.exit(1);
  }

  return {
    run: runString,
    callback: callback
  };
} // mbedBuild

exports.createProject = function createProject(compile_path, runCmd) {
  var args = (typeof runCmd === 'string') ? runCmd.split(' ') : [];
  if (!args.length) {
    console.error(" -", colors.red("error :"),
              "Unknown board name", args[0]);
    console.log('List of supported devices are available under https://os.mbed.com/platforms/');
    process.exit(1);
  } else {
    board = args[0];
  }

  var projectName;
  if (args.length > 1) {
    projectName = args[1];
  }

  var target_folder;
  if (projectName) {
    target_folder = path.join(compile_path, projectName);
    try {
      fs.mkdirSync(target_folder);
    } catch(e) {
      if (!fs.existsSync(target_folder)) {
        console.error(" -", colors.red("error:"), "cant't create folder", projectName);
        process.exit(1);
      }
    }
  } else {
    target_folder = compile_path;
    projectName = "sampleApplication"
  }

  var example = `
// iotz
// sample mbed file

#include "mbed.h"

DigitalOut myled(LED1);

int main() {
    while(1) {
        myled = 1; // LED is ON
        wait(0.2); // 200 ms
        myled = 0; // LED is OFF
        wait(1.0); // 1 sec
    }
}
`;

  var config = `
{
  "name":"${projectName}",
  "toolchain":"mbed",
  "target":"${board}"
}
`;

  fs.writeFileSync(path.join(target_folder, `${projectName}.cpp`), example);
  fs.writeFileSync(path.join(target_folder, `iotz.json`), config);
  console.log(" -", colors.green('done!'));
}
