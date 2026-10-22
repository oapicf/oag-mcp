"use strict";
/* eslint no-unused-vars: 0 */
import Display from '../lib/oag-mcp.js';
import bag from 'bagofcli';
import cli from '../lib/cli.js';
import referee from '@sinonjs/referee';
import sinon from 'sinon';
const assert = referee.assert;

describe('cli - exec', function() {

  it('should contain commands with actions', function (done) {
    const mockCommand = function (base, actions) {
      assert.isString(base);
      assert.isFunction(actions.commands.display.action);
      done();
    };
    sinon.stub(bag, 'command').value(mockCommand);
    cli.exec();
  });
});

describe('cli - display', function() {

  beforeEach(function () {
    this.mockBag = sinon.mock(bag);
  });

  afterEach(function () {
    this.mockBag.verify();
    sinon.restore();
  });

  it('should contain display command and delegate to Display when exec is called', function (done) {
    sinon.stub(bag, 'lookupFile').value(function (configFile) {
      assert.equals(configFile, 'oag-mcp.yaml');
      return 'text: Hello World';
    });
    sinon.stub(bag, 'logStepHeading').value(function () {});
    sinon.stub(bag, 'logStepItemSuccess').value(function () {});
    sinon.stub(bag, 'command').value(function (base, actions) {
      actions.commands.display.action({
        reverse: 'false',
        transform: 'lower',
        parent: {
          configFile: 'oag-mcp.yaml'
        }
      });
      done();
    });
    cli.exec();
  });

  it('should handle display command with reverse and upper transformation', function (done) {
    sinon.stub(bag, 'lookupFile').value(function (configFile) {
      return 'text: Hello World';
    });
    sinon.stub(bag, 'logStepHeading').value(function () {});
    sinon.stub(bag, 'logStepItemSuccess').value(function () {});
    sinon.stub(bag, 'command').value(function (base, actions) {
      actions.commands.display.action({
        reverse: 'true',
        transform: 'upper',
        parent: {
          configFile: 'oag-mcp.yaml'
        }
      });
      done();
    });
    cli.exec();
  });
});