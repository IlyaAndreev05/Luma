export function selectBrightnessBackend({backlight, nativeScale, ddc}) {
    if (backlight || nativeScale)
        return 'mutter';
    if (ddc)
        return 'ddc';
    return 'software';
}

export function normalizeBrightness(value, minimum, maximum) {
    if (!Number.isFinite(value) || !Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum <= minimum)
        return null;
    return Math.min(1, Math.max(0, (value - minimum) / (maximum - minimum)));
}

export function sameDisplayedPercent(displays) {
    return displays.length > 0 && displays.every(display =>
        Math.round(display.value * 100) === Math.round(displays[0].value * 100));
}

export function retryDelay(failures) {
    return Math.min(60000, 2000 * (2 ** Math.min(Math.max(failures - 1, 0), 5)));
}

export function parseDdcReading(output) {
    const match = output.match(/current value\s*=\s*(\d+)\s*,\s*max value\s*=\s*(\d+)/i) ||
        output.match(/current value\s*=\s*(\d+)/i);
    if (!match)
        return null;
    const current = Number(match[1]);
    const maximum = Number(match[2] || 100);
    return maximum > 0 ? {value: Math.min(1, Math.max(0, current / maximum)), maximum} : null;
}

export function parseDdcBrightness(output) {
    return parseDdcReading(output)?.value ?? null;
}

export function parseDdcDetection(output) {
    const result = new Map();
    for (const chunk of output.split(/(?=Display\s+\d+)/i)) {
        const display = chunk.match(/Display\s+\d+[^\n]*I2C bus:\s*([^\s,]+)/i);
        const connector = chunk.match(/DRM connector:\s*([^\s]+)/i);
        if (!display || !connector)
            continue;
        const bus = display[1].match(/i2c-(\d+)/i)?.[1] || display[1];
        result.set(connector[1], {
            bus: Number(bus),
            edid: chunk.match(/EDID:\s*([\da-f]+)/i)?.[1] || '',
        });
        const drmConnector = connector[1].replace(/^card\d+-/, '');
        if (drmConnector !== connector[1])
            result.set(drmConnector, result.get(connector[1]));
    }
    return result;
}
