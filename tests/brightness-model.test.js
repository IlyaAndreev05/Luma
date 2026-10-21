import test from 'node:test';
import assert from 'node:assert/strict';

import {brightnessToSliderPosition, clampBrightnessToMinimum, combinedBrightness, displayBrightnessFromOutput, normalizeBrightness, parseDdcBrightness, parseDdcDetection,
    DdcWriteQueue, ddcReadingMatchesRequest, matchDdcDisplay, normalizeConnector, parseDdcReading, retryDelay,
    sameDisplayedPercent, selectBrightnessBackend, sliderPositionToBrightness} from '../brightness-model.js';

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

test('clamps values below the safe minimum without shifting normal display readings', () => {
    assert.equal(clampBrightnessToMinimum(0), .02);
    assert.equal(clampBrightnessToMinimum(.19), .19);
    assert.equal(clampBrightnessToMinimum(1), 1);
    assert.equal(clampBrightnessToMinimum(0, 10), .1);
    assert.equal(clampBrightnessToMinimum(.19, 10), .19);
    assert.equal(clampBrightnessToMinimum(0, 0), .02);
});

test('maps the safe brightness floor to the slider left edge', () => {
    assert.equal(brightnessToSliderPosition(.02, 2), 0);
    assert.equal(brightnessToSliderPosition(1, 2), 1);
    assert.equal(sliderPositionToBrightness(0, 2), .02);
    assert.equal(sliderPositionToBrightness(1, 2), 1);
    assert.equal(brightnessToSliderPosition(.1, 10), 0);
    assert.ok(Math.abs(sliderPositionToBrightness(brightnessToSliderPosition(.55, 10), 10) - .55) < 1e-12);
});

test('keeps overall and per-display brightness independent and combines them only at output', () => {
    const displayBrightness = .3;
    const globalBrightness = .5;

    assert.equal(combinedBrightness(globalBrightness, displayBrightness), .15);
    assert.equal(displayBrightness, .3);
    assert.equal(combinedBrightness(1, displayBrightness), .3);
    assert.equal(combinedBrightness(globalBrightness, 1), .5);
    assert.ok(Math.abs(displayBrightnessFromOutput(.4, .5) - .8) < 1e-12);
});

test('combined output respects the configured safe minimum', () => {
    assert.equal(combinedBrightness(0, 0, 2), .02);
    assert.equal(combinedBrightness(.5, .3, 10), .15);
    assert.equal(combinedBrightness(.02, .02, 10), .1);
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

test('accepts only a near-enough hardware confirmation for a DDC request', () => {
    assert.equal(ddcReadingMatchesRequest(.51, .5, 100), true);
    assert.equal(ddcReadingMatchesRequest(.51, .47, 100), false);
    assert.equal(ddcReadingMatchesRequest(.2, .19, 255), true);
    assert.equal(ddcReadingMatchesRequest(.5, Number.NaN, 100), false);
});

test('coalesces DDC writes and never publishes or retries an obsolete in-flight value', () => {
    const queue = new DdcWriteQueue();
    queue.enqueue(.9);
    queue.enqueue(.8);
    queue.enqueue(.2);

    const older = queue.take(100);
    assert.deepEqual(older, {generation: 3, value: 20});

    queue.enqueue(.3);
    assert.equal(queue.canPublish(older.generation), false);
    assert.equal(queue.retry(older), false);
    assert.deepEqual(queue.take(100), {generation: 4, value: 30});
});

test('converts the latest normalized DDC request using the monitor maximum and retries only current writes', () => {
    const queue = new DdcWriteQueue();
    queue.enqueue(.2);
    const request = queue.take(255);
    assert.deepEqual(request, {generation: 1, value: 51});
    assert.equal(queue.retry(request), true);
    assert.equal(queue.pendingValue, 51);

    queue.enqueue(.3, 255);
    assert.equal(queue.retry(request), false);
    assert.deepEqual(queue.take(255), {generation: 2, value: 77});
    assert.equal(queue.canPublish(2), true);
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
