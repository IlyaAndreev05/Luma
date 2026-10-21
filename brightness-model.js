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

export function clampBrightnessToMinimum(value, minimumPercent = 2) {
    const minimum = Math.min(20, Math.max(2, Number(minimumPercent) || 2)) / 100;
    const normalized = Math.min(1, Math.max(0, Number(value) || 0));
    return Math.max(minimum, normalized);
}

export function brightnessToSliderPosition(value, minimumPercent = 2) {
    const minimum = Math.min(20, Math.max(2, Number(minimumPercent) || 2)) / 100;
    const brightness = clampBrightnessToMinimum(value, minimumPercent);
    return (brightness - minimum) / (1 - minimum);
}

export function sliderPositionToBrightness(position, minimumPercent = 2) {
    const minimum = Math.min(20, Math.max(2, Number(minimumPercent) || 2)) / 100;
    const normalizedPosition = Math.min(1, Math.max(0, Number(position) || 0));
    return minimum + normalizedPosition * (1 - minimum);
}

export function sameDisplayedPercent(displays) {
    return displays.length > 0 && displays.every(display =>
        Math.round(display.value * 100) === Math.round(displays[0].value * 100));
}

export function retryDelay(failures) {
    return Math.min(60000, 2000 * (2 ** Math.min(Math.max(failures - 1, 0), 5)));
}

export function ddcReadingMatchesRequest(requested, actual, maximum = 100) {
    if (!Number.isFinite(requested) || !Number.isFinite(actual))
        return false;
    const scale = Number.isFinite(maximum) && maximum > 0 ? maximum : 100;
    const tolerance = Math.max(0.015, 1.5 / scale);
    return Math.abs(requested - actual) <= tolerance;
}

export class DdcWriteQueue {
    constructor() {
        this.generation = 0;
        this.pendingValue = null;
        this.normalizedValue = null;
    }

    enqueue(value, maximum = 100) {
        const normalized = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
        const scale = Number.isFinite(maximum) && maximum > 0 ? maximum : 100;
        this.generation++;
        this.normalizedValue = normalized;
        this.pendingValue = Math.round(normalized * scale);
        return this.generation;
    }

    get hasPending() {
        return this.pendingValue !== null;
    }

    isLatest(generation) {
        return generation === this.generation;
    }

    canPublish(generation) {
        return this.isLatest(generation) && !this.hasPending;
    }

    take(maximum) {
        if (!this.hasPending)
            return null;
        const scale = Number.isFinite(maximum) && maximum > 0 ? maximum : 100;
        const request = {
            generation: this.generation,
            value: Math.round(this.normalizedValue * scale),
        };
        this.pendingValue = null;
        return request;
    }

    retry(request) {
        if (!this.canPublish(request.generation))
            return false;
        this.pendingValue = request.value;
        return true;
    }

    clear() {
        this.generation++;
        this.pendingValue = null;
        this.normalizedValue = null;
    }
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
    const result = [];
    for (const chunk of output.split(/(?=Display\s+\d+)/i)) {
        const display = chunk.match(/I2C bus:\s*([^\s,]+)/i);
        const connector = chunk.match(/DRM connector:\s*([^\s]+)/i);
        if (!display)
            continue;
        const bus = display[1].match(/i2c-(\d+)/i)?.[1] || display[1];
        const monitor = chunk.match(/Monitor:\s*([^:\n]+):([^:\n]+)(?::([^\n]+))?/i);
        result.push({
            bus: Number(bus),
            edid: chunk.match(/EDID:\s*([\da-f]+)/i)?.[1] || '',
            connector: connector?.[1]?.replace(/^card\d+-/, '') || '',
            vendor: monitor?.[1]?.trim() || '',
            product: monitor?.[2]?.trim() || '',
            serial: monitor?.[3]?.trim() || '',
        });
    }
    return result;
}

function identityPart(value) {
    return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function normalizeConnector(connector) {
    return String(connector ?? '')
        .trim()
        .replace(/^card\d+-/i, '')
        .replace(/^(HDMI)-A-(\d+)$/i, '$1-$2')
        .toUpperCase();
}

export function matchDdcDisplay(displays, monitor) {
    const vendor = identityPart(monitor?.vendor);
    const product = identityPart(monitor?.product);
    const serial = identityPart(monitor?.serial);
    const compatibleIdentity = display => {
        const candidateVendor = identityPart(display.vendor);
        const candidateProduct = identityPart(display.product);
        const candidateSerial = identityPart(display.serial);
        return (!vendor || !candidateVendor || vendor === candidateVendor) &&
            (!product || !candidateProduct || product === candidateProduct) &&
            (!serial || !candidateSerial || serial === candidateSerial);
    };

    let identityMatches = null;
    if (serial) {
        const matches = displays.filter(display => identityPart(display.serial) === serial && compatibleIdentity(display));
        if (matches.length === 1)
            return matches[0];
        if (matches.length > 1)
            identityMatches = matches;
    } else if (vendor && product) {
        const matches = displays.filter(display =>
            compatibleIdentity(display) && identityPart(display.vendor) === vendor &&
            identityPart(display.product) === product);
        if (matches.length === 1)
            return matches[0];
        if (matches.length > 1)
            identityMatches = matches;
    }

    const connector = normalizeConnector(monitor?.connector);
    if (!connector)
        return null;
    const matches = displays.filter(display =>
        (!identityMatches || identityMatches.includes(display)) &&
        compatibleIdentity(display) && normalizeConnector(display.connector) === connector);
    return matches.length === 1 ? matches[0] : null;
}
