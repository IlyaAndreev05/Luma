import test from 'node:test';
import assert from 'node:assert/strict';

import {normalizeBrightness, parseDdcBrightness, parseDdcDetection,
    parseDdcReading, retryDelay, sameDisplayedPercent, selectBrightnessBackend} from '../brightness-model.js';

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

test('matches DDC devices by connector and extracts the I2C bus', () => {
    const result = parseDdcDetection('Display 1, I2C bus: /dev/i2c-7, DRM connector: card1-DP-1\nEDID: ABCD\nDisplay 2, I2C bus: /dev/i2c-9, DRM connector: card1-HDMI-A-1');
    assert.deepEqual(result.get('card1-DP-1'), {bus: 7, edid: 'ABCD'});
    assert.deepEqual(result.get('DP-1'), {bus: 7, edid: 'ABCD'});
    assert.deepEqual(result.get('card1-HDMI-A-1'), {bus: 9, edid: ''});
});
