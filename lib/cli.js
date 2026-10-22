"use strict";
import bag from 'bagofcli';
import p from 'path';
import Display from './oag-mcp.js';

const DIRNAME = p.dirname(import.meta.url).replace('file://', '');

function _display(args) {
  args = args || {};

  const configFile = args.parent && args.parent.configFile ? args.parent.configFile : 'oag-mcp.yaml';
  const reverse = args.reverse === 'true' || args.reverse === true;
  const transformation = args.transform || 'lower';

  bag.logStepHeading('Displaying message');
  const display = new Display(configFile);
  const text = display.format(reverse, transformation);
  console.log('Message: %s', text);
}

/**
 * Execute oag-mcp CLI.
 */
function exec() {

  const actions = {
    commands: {
      display: { action: _display }
    }
  };

  bag.command(DIRNAME, actions);
}

const exports = {
  exec: exec
};

export {
  exports as default
};