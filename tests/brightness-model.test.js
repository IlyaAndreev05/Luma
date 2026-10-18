import test from 'node:test';
import assert from 'node:assert/strict';

import {brightnessFromDevice, brightnessToDevice, normalizeBrightness, parseDdcBrightness, parseDdcDetection,
    matchDdcDisplay, normalizeConnector, parseDdcReading, retryDelay,
    sameDisplayedPercent, selectBrightnessBackend} from '../brightness-model.js';

test('selects native backlight before DDC/CI and software', () => {
    assert.equal(selectBrightnessBackend({backlight: true, ddc: true}), 'mutter');
    assert.equal(selectBrightnessBackend({nativeScale: true, ddc: true}), 'mutter');
    assert.equal(selectBrightnessBackend({ddc: true}), 'ddc');
    assert.equal(selectBrightnessBackend({}), 'software');
});

test('normalizes hardware ranges, including a nonzero minimum', () => {
    assert.equal(normalizeBrightness(30, 10, 110), .2);
    assert.equal(normalizeBrightness(0, 10, 110), 0);
    assert.equal(normalizeBrightness(120, 10, 110), 1);
    assert.equal(normalizeBrightness(5, 7, 7), null);
});

test('maps the UI brightness range to a safe nonzero device range', () => {
    assert.equal(brightnessToDevice(0), .02);
    assert.equal(brightnessToDevice(1), 1);
    assert.equal(brightnessFromDevice(.02), 0);
    assert.equal(brightnessFromDevice(1), 1);
    assert.equal(brightnessToDevice(0, 10), .1);
    assert.equal(brightnessFromDevice(.1, 10), 0);
    assert.equal(brightnessToDevice(0, 0), .02);
});

test('detects equality using the displayed whole percentages', () => {
    assert.equal(sameDisplayedPercent([{value: .374}, {value: .371}]), true);
    assert.equal(sameDisplayedPercent([{value: .37}, {value: .38}]), false);
    assert.equal(sameDisplayedPercent([]), false);
});

test('bounds exponential DDC retry delay at one minute', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 10].map(retryDelay),
        [2000, 4000, 8000, 16000, 32000, 60000, 60000]);
});

test('parses DDC current and maximum brightness values', () => {
    assert.equal(parseDdcBrightness('VCP code 0x10: current value = 37, max value = 100'), .37);
    assert.equal(parseDdcBrightness('current value = 50'), .5);
    assert.deepEqual(parseDdcReading('current value = 20, max value = 255'), {value: 20 / 255, maximum: 255});
    assert.equal(parseDdcBrightness('invalid output'), null);
});

test('parses the multiline ddcutil brief output and matches EDID identity', () => {
    const result = parseDdcDetection(`Display 1
   I2C bus:          /dev/i2c-4
   DRM connector:    card1-HDMI-A-1
   Monitor:          BNQ:BenQ PD3200Q:J8J00785019`);
    assert.deepEqual(result, [{
        bus: 4,
        edid: '',
        connector: 'HDMI-A-1',
        vendor: 'BNQ',
        product: 'BenQ PD3200Q',
        serial: 'J8J00785019',
    }]);
    assert.equal(matchDdcDisplay(result, {
        connector: 'HDMI-1', vendor: 'BNQ', product: 'BenQ PD3200Q', serial: 'J8J00785019',
    }), result[0]);
});

test('normalizes connector aliases and refuses ambiguous fallback matches', () => {
    assert.equal(normalizeConnector('card1-HDMI-A-1'), 'HDMI-1');
    assert.equal(normalizeConnector('HDMI-1'), 'HDMI-1');
    const displays = [
        {bus: 4, connector: 'HDMI-A-1', vendor: 'BNQ', product: 'BenQ PD3200Q', serial: 'J8J00785019'},
        {bus: 5, connector: 'DP-1', vendor: 'BNQ', product: 'BenQ PD3200Q', serial: 'J8J00785019'},
    ];
    assert.equal(matchDdcDisplay(displays, {connector: 'DP-1', vendor: 'BNQ', product: 'BenQ PD3200Q', serial: 'missing'}), null);
    assert.equal(matchDdcDisplay([
        {bus: 4, connector: 'HDMI-A-1'},
        {bus: 5, connector: 'HDMI-1'},
    ], {connector: 'HDMI-1'}), null);
});

test('matches identical monitor models by unique serial number', () => {
    const displays = [
        {bus: 4, connector: 'HDMI-A-1', vendor: 'BNQ', product: 'BenQ PD3200Q', serial: 'ONE'},
        {bus: 5, connector: 'HDMI-A-2', vendor: 'BNQ', product: 'BenQ PD3200Q', serial: 'TWO'},
    ];
    assert.equal(matchDdcDisplay(displays, {vendor: 'BNQ', product: 'BenQ PD3200Q', serial: 'TWO'}), displays[1]);
    assert.equal(matchDdcDisplay(displays, {vendor: 'BNQ', product: 'BenQ PD3200Q'}), null);
    assert.equal(matchDdcDisplay(displays, {
        connector: 'HDMI-1', vendor: 'BNQ', product: 'BenQ PD3200Q',
    }), displays[0]);
});
