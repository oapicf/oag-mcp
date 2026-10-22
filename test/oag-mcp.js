"use strict";
/* eslint no-unused-vars: 0 */
import esmock from 'esmock';
import referee from '@sinonjs/referee';
import sinon from 'sinon';
const assert = referee.assert;

describe('oag-mcp - Display', function() {

  beforeEach(function () {
    this.mockBag = {
      logStepItemSuccess: sinon.stub(),
      lookupFile: sinon.stub().returns('text: Hello World')
    };
  });

  afterEach(function () {
    sinon.restore();
  });

  it('should format text with lower transformation and no reverse', async function () {
    const Display = await esmock('../lib/oag-mcp.js', {
      'bagofcli': this.mockBag,
      'yaml-js': {
        load: () => ({ text: 'Hello World' })
      }
    });

    const display = new Display('oag-mcp.yaml');
    const text = display.format(false, 'lower');
    assert.equals(text, 'hello world');
  });

  it('should format text with upper transformation and reverse', async function () {
    const Display = await esmock('../lib/oag-mcp.js', {
      'bagofcli': this.mockBag,
      'yaml-js': {
        load: () => ({ text: 'Hello World' })
      }
    });

    const display = new Display('oag-mcp.yaml');
    const text = display.format(true, 'upper');
    assert.equals(text, 'DLROW OLLEH');
  });

  it('should format text with no transformation', async function () {
    const Display = await esmock('../lib/oag-mcp.js', {
      'bagofcli': this.mockBag,
      'yaml-js': {
        load: () => ({ text: 'Hello World' })
      }
    });

    const display = new Display('oag-mcp.yaml');
    const text = display.format(false, null);
    assert.equals(text, 'Hello World');
  });
});
