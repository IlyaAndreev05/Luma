import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {QuickSlider, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {brightnessToSliderPosition, clampBrightnessToMinimum, combinedBrightness, displayBrightnessFromOutput, normalizeBrightness, parseDdcDetection,
    parseDdcReading, retryDelay, sliderPositionToBrightness, DdcWriteQueue,
    ddcReadingMatchesRequest, matchDdcDisplay, selectBrightnessBackend} from './brightness-model.js';

const DDC_TIMEOUT_MS = 3000;
const DDC_DEBOUNCE_MS = 100;
const DDC_CONFIRM_DELAY_MS = 500;
const DDC_CONFIRM_RETRY_MS = 400;
const DDC_CONFIRM_MAX_ATTEMPTS = 4;
function finite(value, fallback = 1) {
    return Number.isFinite(value) ? Math.clamp(value, 0, 1) : fallback;
}

class DdcController {
    constructor(connector, bus) {
        this.connector = connector;
        this.bus = bus;
        this.process = null;
        this.timer = 0;
        this.confirmTimer = 0;
        this.confirmation = null;
        this.writeQueue = new DdcWriteQueue();
        this.lastValue = null;
        this.failures = 0;
        this.nextRetryAt = 0;
        this.maximum = null;
        this.onChange = null;
        this.onFailure = null;
        this.onMismatch = null;
        this.onUnconfirmed = null;
        this.destroyed = false;
    }

    set(value) {
        if (this.confirmTimer)
            GLib.Source.remove(this.confirmTimer);
        this.confirmTimer = 0;
        this.confirmation = null;
        this.writeQueue.enqueue(finite(value), this.maximum || 100);
        this.failures = 0;
        this.nextRetryAt = 0;
        this._scheduleWrite(DDC_DEBOUNCE_MS);
    }

    _scheduleWrite(delay) {
        if (this.timer || this.process || this.destroyed || this.paused || !this.writeQueue.hasPending)
            return;
        this.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this.timer = 0;
            this._write();
            return GLib.SOURCE_REMOVE;
        });
    }

    pause() {
        this.paused = true;
        if (this.timer)
            GLib.Source.remove(this.timer);
        this.timer = 0;
        if (this.confirmTimer)
            GLib.Source.remove(this.confirmTimer);
        this.confirmTimer = 0;
        this.process?.force_exit();
    }

    resume() {
        this.paused = false;
        if (this.confirmation) {
            const {generation, target, attempt} = this.confirmation;
            this._scheduleConfirmation(generation, target, attempt, DDC_CONFIRM_DELAY_MS);
        } else {
            this._scheduleWrite(DDC_DEBOUNCE_MS);
        }
    }

    async read({allowPending = false, schedulePending = true, publish = true, confirm = false} = {}) {
        if (this.process || this.destroyed || this.paused || Date.now() < this.nextRetryAt)
            return null;
        if (this.confirmation && !confirm)
            return null;
        if (this.writeQueue.hasPending && !allowPending)
            return null;
        const generation = this.writeQueue.generation;
        try {
            const result = await this._run(['getvcp', '10']);
            if (result === null) {
                if (this.writeQueue.isLatest(generation) && (allowPending || !this.writeQueue.hasPending))
                    this._failed();
                return null;
            }
            const reading = parseDdcReading(result);
            if (!reading) {
                if (this.writeQueue.isLatest(generation) && (allowPending || !this.writeQueue.hasPending))
                    this._failed();
                return null;
            }
            this.failures = 0;
            this.nextRetryAt = 0;
            this.maximum = reading.maximum;
            this.lastValue = reading.value;
            // A poll that began before a newer request must never move its slider back.
            if (publish && this.writeQueue.canPublish(generation))
                this.onChange?.(this.lastValue, false, false);
            return reading;
        } finally {
            if (schedulePending && this.writeQueue.hasPending)
                this._scheduleWrite(DDC_DEBOUNCE_MS);
        }
    }

    async _write() {
        if (!this.writeQueue.hasPending || this.process || this.destroyed)
            return;
        if (!this.maximum) {
            // Read the device range before the first write, without publishing the
            // old hardware value over the user's pending slider position.
            await this.read({allowPending: true, schedulePending: false});
            if (!this.maximum) {
                this._scheduleWrite(retryDelay(Math.max(1, this.failures)));
                return;
            }
        }
        const request = this.writeQueue.take(this.maximum);
        if (!request)
            return;
        const result = await this._run(['setvcp', '10', String(request.value)]);
        if (result === null) {
            // Don't requeue an obsolete value if the user moved the slider while
            // this DDC/CI command was still running.
            if (this.writeQueue.retry(request)) {
                const delay = this._failed() || retryDelay(Math.max(1, this.failures));
                this._scheduleWrite(delay);
            } else {
                this._scheduleWrite(DDC_DEBOUNCE_MS);
            }
        } else if (this.writeQueue.canPublish(request.generation)) {
            // DDC/CI writes can return before the monitor applies the new VCP value.
            // Wait for the panel to settle, then publish only a matching read-back.
            this._scheduleConfirmation(request.generation, request.value / (this.maximum || 100));
        }
        this._scheduleWrite(DDC_DEBOUNCE_MS);
    }

    _scheduleConfirmation(generation, target, attempt = 0, delay = DDC_CONFIRM_DELAY_MS) {
        if (this.confirmTimer)
            GLib.Source.remove(this.confirmTimer);
        this.confirmTimer = 0;
        this.confirmation = {generation, target, attempt};
        if (this.destroyed || this.paused)
            return;
        this.confirmTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this.confirmTimer = 0;
            this._confirm(generation, target, attempt);
            return GLib.SOURCE_REMOVE;
        });
    }

    async _confirm(generation, target, attempt) {
        if (!this.writeQueue.canPublish(generation)) {
            this.confirmation = null;
            return;
        }

        const reading = await this.read({schedulePending: false, publish: false, confirm: true});
        if (!this.writeQueue.canPublish(generation)) {
            this.confirmation = null;
            this._scheduleWrite(DDC_DEBOUNCE_MS);
            return;
        }

        if (!reading) {
            if (attempt >= DDC_CONFIRM_MAX_ATTEMPTS) {
                this.confirmation = null;
                this.onUnconfirmed?.();
                return;
            }
            const backoff = Math.max(DDC_CONFIRM_RETRY_MS, this.nextRetryAt - Date.now());
            this._scheduleConfirmation(generation, target, attempt + 1, backoff);
            return;
        }

        if (ddcReadingMatchesRequest(target, reading.value, reading.maximum)) {
            this.confirmation = null;
            this.onChange?.(reading.value, true);
        } else if (attempt >= DDC_CONFIRM_MAX_ATTEMPTS) {
            this.confirmation = null;
            this.onChange?.(reading.value, false, true);
            this.onMismatch?.();
        } else {
            this._scheduleConfirmation(generation, target, attempt + 1, DDC_CONFIRM_RETRY_MS);
        }
    }

    _run(args) {
        if (this.destroyed)
            return Promise.resolve(null);
        let process;
        try {
            process = Gio.Subprocess.new(
                ['ddcutil', '--bus', String(this.bus), '--sleep-multiplier', '.2', ...args],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (error) {
            return Promise.resolve(null);
        }
        this.process = process;
        return new Promise(resolve => {
            let completed = false;
            const timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DDC_TIMEOUT_MS, () => {
                completed = true;
                process.force_exit();
                return GLib.SOURCE_REMOVE;
            });
            process.communicate_utf8_async(null, null, (proc, result) => {
                if (!completed)
                    GLib.Source.remove(timeout);
                completed = true;
                try {
                    const [, stdout] = proc.communicate_utf8_finish(result);
                    resolve(proc.get_successful() ? stdout : null);
                } catch (error) {
                    resolve(null);
                }
                if (this.process === proc)
                    this.process = null;
            });
        });
    }

    _failed() {
        if (this.paused || this.destroyed)
            return;
        this.failures++;
        this.nextRetryAt = Date.now() + retryDelay(this.failures);
        this.onFailure?.();
        return retryDelay(this.failures);
    }

    destroy() {
        this.destroyed = true;
        if (this.timer)
            GLib.Source.remove(this.timer);
        this.timer = 0;
        if (this.confirmTimer)
            GLib.Source.remove(this.confirmTimer);
        this.confirmTimer = 0;
        this.confirmation = null;
        this.process?.force_exit();
        this.process = null;
        this.writeQueue.clear();
        this.onChange = null;
        this.onFailure = null;
        this.onMismatch = null;
        this.onUnconfirmed = null;
    }
}

class BrightnessService {
    constructor(settings, onChanged) {
        this._settings = settings;
        this._onChanged = onChanged;
        this._displays = [];
        this._generation = 0;
        this._scanTimer = 0;
        this._pollTimer = 0;
        this._pollDue = 0;
        this._monitorManager = global.backend.get_monitor_manager();
        this._lastAppliedGlobalPercent = this._settings.get_int('global-brightness');
        this._settings.connectObject('changed::global-brightness', () => {
            const percent = this._settings.get_int('global-brightness');
            if (percent === this._lastAppliedGlobalPercent)
                return;
            this._lastAppliedGlobalPercent = percent;
            this._applyOverallBrightness();
        }, this);
        this._settings.connectObject('changed::minimum-brightness', () => this._applyOverallBrightness(), this);
        this._monitorManager.connectObject('monitors-changed', () => this.refresh(), this);
        Main.brightnessManager.connectObject('changed', () => this._readNative(), this);
        Main.brightnessManager.connectObject('user-update', () => this._readNative(), this);
        Main.sessionMode.connectObject('updated', () => {
            const paused = Main.sessionMode.isLocked || Main.sessionMode.isGreeter;
            for (const device of this._displays)
                paused ? device.ddc?.pause() : device.ddc?.resume();
            this._schedulePoll();
        }, this);
        this.refresh();
    }

    async refresh() {
        const generation = ++this._generation;
        this._destroyDevices();
        let ddcMap = [];
        try {
            const output = await this._subprocess(['ddcutil', 'detect', '--brief'], 6000);
            if (output)
                ddcMap = parseDdcDetection(output);
        } catch (error) {
            // DDC/CI is optional; the device remains visible as software-controlled.
        }
        if (generation !== this._generation)
            return;

        const monitors = this._monitorManager.get_logical_monitors();
        for (const logical of monitors) {
            for (const monitor of logical.get_monitors()) {
                if (monitor.is_active && !monitor.is_active())
                    continue;
                const connector = monitor.get_connector?.() || monitor.get_display_name();
                const backlight = monitor.get_backlight?.();
                const ddc = matchDdcDisplay(ddcMap, {
                    connector,
                    vendor: monitor.get_vendor?.(),
                    product: monitor.get_product?.(),
                    serial: monitor.get_serial?.(),
                });
                const nativeScale = Main.brightnessManager.scales.find(s => s.monitor === logical);
                const backend = selectBrightnessBackend({backlight, nativeScale, ddc: Boolean(ddc)});
                const deviceValue = backlight
                    ? normalizeBrightness(backlight.brightness, backlight.brightnessMin, backlight.brightnessMax)
                    : nativeScale?.value;
                const value = deviceValue;
                const edid = ddc?.edid || monitor.get_vendor?.() + monitor.get_product?.() + monitor.get_serial?.();
                const device = {
                    id: `${edid || 'unknown'}|${connector}`,
                    connector,
                    name: monitor.get_display_name?.() || connector,
                    logical,
                    monitor,
                    backlight,
                    nativeScale,
                    ddc: backend === 'ddc' && ddc ? new DdcController(connector, ddc.bus) : null,
                    backend,
                    value: finite(value, 1),
                    softwareValue: finite(value, 1),
                    hardwareValue: backend === 'software' || value === undefined || value === null ? null : finite(value, 1),
                    hardwareInitialized: backend !== 'ddc' && (value !== undefined && value !== null),
                    error: '',
                };
                if (device.ddc) {
                    device.ddc.onChange = (actual, confirmed = false, mismatch = false) =>
                        this._acceptHardwareBrightness(device, actual, confirmed, mismatch);
                    device.ddc.onFailure = () => {
                        device.error = _('Could not read or apply monitor brightness; check DDC/CI and device access.');
                        this._emit();
                    };
                    device.ddc.onMismatch = () => {
                        device.error = _('The monitor reported a different brightness than requested.');
                        this._emit();
                    };
                    device.ddc.onUnconfirmed = () => {
                        device.requestedValue = null;
                        device.requestedOutputValue = null;
                        device.error = _('The monitor did not confirm the requested brightness.');
                        this._emit();
                    };
                }
                this._displays.push(device);
                this._applyBrightnessOverlay(device);
                const saved = this._settings.get_value('saved-brightness').deep_unpack();
                if (this._settings.get_boolean('restore-brightness')) {
                    if (saved[device.id] !== undefined)
                        this.setBrightness(device.id, saved[device.id]);
                    else if (device.backend !== 'software' && device.backend !== 'ddc')
                        this._initializeHardwareBrightness(device, undefined);
                } else if (device.backend !== 'software' && device.backend !== 'ddc') {
                    this._initializeHardwareBrightness(device, saved[device.id]);
                }
            }
        }
        this._pollDdcQueue();
        this._schedulePoll();
        this._emit();
    }

    _subprocess(argv, timeoutMs) {
        return new Promise(resolve => {
            let proc;
            try {
                proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            } catch (error) {
                resolve(null);
                return;
            }
            let completed = false;
            const timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
                completed = true;
                proc.force_exit();
                resolve(null);
                return GLib.SOURCE_REMOVE;
            });
            proc.communicate_utf8_async(null, null, (source, result) => {
                if (!completed)
                    GLib.Source.remove(timeout);
                completed = true;
                try {
                    const [, stdout] = source.communicate_utf8_finish(result);
                    resolve(source.get_successful() ? stdout : null);
                } catch (error) {
                    resolve(null);
                }
            });
        });
    }

    _destroyDevices() {
        this._displays.forEach(d => {
            d.ddc?.destroy();
            d.overlay?.destroy();
        });
        this._displays = [];
    }

    setBrightness(id, value) {
        const device = this._displays.find(d => d.id === id);
        if (!device)
            return;
        const minimum = this._settings.get_int('minimum-brightness');
        value = clampBrightnessToMinimum(finite(value), minimum);
        const outputValue = combinedBrightness(this.globalBrightness, value, minimum);
        if (!device.ddc && device.backend === 'mutter' && device.hardwareValue !== null &&
            (device.requestedValue === undefined || device.requestedValue === null) &&
            ddcReadingMatchesRequest(outputValue, device.hardwareValue, 100)) {
            device.value = value;
            device.requestedOutputValue = null;
            this._saveConfirmed(device);
            this._emit();
            return;
        }
        if (device.ddc) {
            device.error = '';
            device.requestedValue = value;
            device.requestedOutputValue = outputValue;
            device.ddc.set(outputValue);
            this._emit();
            return;
        }
        if (device.backend === 'mutter' && device.backlight) {
            const {brightnessMin, brightnessMax} = device.backlight;
            device.requestedValue = value;
            device.requestedOutputValue = outputValue;
            device.backlight.brightness = Math.round(brightnessMin + outputValue * (brightnessMax - brightnessMin));
        } else if (device.backend === 'mutter' && device.nativeScale) {
            device.requestedValue = value;
            device.requestedOutputValue = outputValue;
            device.nativeScale.value = outputValue;
        } else {
            // Software dimming is explicitly shown in the UI and never changes the reported hardware level.
            device.softwareValue = value;
            device.value = value;
            device.requestedValue = null;
            device.requestedOutputValue = null;
            this._applyBrightnessOverlay(device);
            this._saveConfirmed(device);
        }
        this._emit();
    }

    get globalBrightness() {
        return clampBrightnessToMinimum(
            this._settings.get_int('global-brightness') / 100,
            this._settings.get_int('minimum-brightness'));
    }

    _applyBrightnessOverlay(device) {
        const minimum = this._settings.get_int('minimum-brightness');
        const value = device.backend === 'software'
            ? combinedBrightness(this.globalBrightness, device.softwareValue ?? device.value, minimum)
            : 1;
        this._setOverlay(device, value);
    }

    _applyOverallBrightness() {
        const wasBatching = this._batch;
        this._batch = true;
        try {
            for (const device of this._displays) {
                if (device.backend === 'software')
                    this._applyBrightnessOverlay(device);
                else if (device.ddc && !device.hardwareInitialized &&
                    (device.requestedValue === undefined || device.requestedValue === null))
                    continue;
                else
                    this.setBrightness(device.id, device.requestedValue ?? device.value);
            }
        } finally {
            this._batch = wasBatching;
        }
        this._emit();
    }

    _acceptHardwareBrightness(device, actual, confirmed = false, mismatch = false) {
        const minimum = this._settings.get_int('minimum-brightness');
        const previousHardwareValue = device.hardwareValue;
        const firstReading = !device.hardwareInitialized;
        const changed = previousHardwareValue === null || Math.abs(actual - previousHardwareValue) > .015;
        const requested = device.requestedValue;

        if (requested !== undefined && requested !== null && !confirmed && !mismatch && !changed)
            return;

        let localValue;
        if (confirmed && requested !== undefined && requested !== null) {
            localValue = requested;
        } else if (firstReading) {
            const saved = this._settings.get_value('saved-brightness').deep_unpack()[device.id];
            const savedOutput = saved === undefined ? null : combinedBrightness(this.globalBrightness, saved, minimum);
            if (this._settings.get_boolean('restore-brightness') && saved !== undefined) {
                localValue = saved;
            } else if (savedOutput !== null && ddcReadingMatchesRequest(savedOutput, actual, 100)) {
                localValue = saved;
            } else {
                localValue = actual;
            }
        } else if ((requested !== undefined && requested !== null) || changed) {
            localValue = displayBrightnessFromOutput(actual, this.globalBrightness, minimum);
        } else {
            localValue = device.value;
        }

        device.hardwareValue = actual;
        device.hardwareInitialized = true;
        device.value = clampBrightnessToMinimum(localValue, minimum);
        device.requestedValue = null;
        device.requestedOutputValue = null;
        device.error = '';
        this._saveConfirmed(device);

        if (!confirmed && !mismatch && (firstReading || changed)) {
            const expected = combinedBrightness(this.globalBrightness, device.value, minimum);
            if (!ddcReadingMatchesRequest(expected, actual, 100)) {
                this.setBrightness(device.id, device.value);
                return;
            }
        }

        this._emit();
    }

    _initializeHardwareBrightness(device, savedValue) {
        const minimum = this._settings.get_int('minimum-brightness');
        let localValue = device.value;
        if (savedValue !== undefined && device.hardwareValue !== null) {
            const savedOutput = combinedBrightness(this.globalBrightness, savedValue, minimum);
            localValue = ddcReadingMatchesRequest(savedOutput, device.hardwareValue, 100)
                ? savedValue
                : displayBrightnessFromOutput(device.hardwareValue, this.globalBrightness, minimum);
        }
        device.value = clampBrightnessToMinimum(localValue, minimum);
        const expectedOutput = combinedBrightness(this.globalBrightness, device.value, minimum);
        if (!ddcReadingMatchesRequest(expectedOutput, device.hardwareValue, 100))
            this.setBrightness(device.id, device.value);
        else
            this._saveConfirmed(device);
    }

    _setOverlay(device, value) {
        value = Math.min(1, Math.max(0, finite(value, 1)));
        if (value >= .999) {
            device.overlay?.destroy();
            device.overlay = null;
            return;
        }
        if (!device.overlay) {
            device.overlay = new St.Widget({
                reactive: false,
                can_focus: false,
                style: `background-color: rgba(0,0,0,${Math.max(0, 1 - value)});`,
            });
            Main.uiGroup.add_child(device.overlay);
        } else {
            device.overlay.set_style(`background-color: rgba(0,0,0,${Math.max(0, 1 - value)});`);
        }
        const monitorNumber = device.monitor.get_number?.();
        const monitor = Main.layoutManager.monitors.find(m => m.index === monitorNumber);
        if (monitor)
            device.overlay.set_position(monitor.x, monitor.y), device.overlay.set_size(monitor.width, monitor.height);
    }

    setGlobalBrightness(value) {
        const minimum = this._settings.get_int('minimum-brightness');
        const percent = Math.round(clampBrightnessToMinimum(value, minimum) * 100);
        this._lastAppliedGlobalPercent = percent;
        this._settings.set_int('global-brightness', percent);
        this._applyOverallBrightness();
    }

    _saveConfirmed(device) {
        const saved = this._settings.get_value('saved-brightness').deep_unpack();
        saved[device.id] = device.value;
        this._settings.set_value('saved-brightness', new GLib.Variant('a{sd}', saved));
    }

    _readNative() {
        const wasBatching = this._batch;
        this._batch = true;
        try {
            for (const device of this._displays) {
                if (device.backlight) {
                    const {brightness, brightnessMin, brightnessMax} = device.backlight;
                    const actual = normalizeBrightness(brightness, brightnessMin, brightnessMax);
                    if (actual !== null) {
                        const confirmed = device.requestedValue !== undefined && device.requestedValue !== null &&
                            ddcReadingMatchesRequest(device.requestedOutputValue, actual, 100);
                        this._acceptHardwareBrightness(device, actual, confirmed);
                    }
                } else if (device.nativeScale) {
                    const actual = finite(device.nativeScale.value);
                    const confirmed = device.requestedValue !== undefined && device.requestedValue !== null &&
                        ddcReadingMatchesRequest(device.requestedOutputValue, actual, 100);
                    this._acceptHardwareBrightness(device, actual, confirmed);
                }
            }
        } finally {
            this._batch = wasBatching;
        }
        this._emit();
    }

    setMenuOpen(open) {
        this._pollDue = open ? 2000 : this._settings.get_int('ddc-refresh-seconds') * 1000;
        this._schedulePoll();
    }

    _schedulePoll() {
        if (this._pollTimer)
            GLib.Source.remove(this._pollTimer);
        this._pollTimer = 0;
        if (Main.sessionMode.isLocked || Main.sessionMode.isGreeter || this._displays.length === 0)
            return;
        const delay = this._pollDue || this._settings.get_int('ddc-refresh-seconds') * 1000;
        this._pollTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._pollTimer = 0;
            this._pollDdcQueue();
            this._readNative();
            this._schedulePoll();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _pollDdcQueue() {
        for (const device of this._displays) {
            if (Main.sessionMode.isLocked || Main.sessionMode.isGreeter)
                return;
            if (device.ddc)
                await device.ddc.read();
        }
    }

    _emit() {
        if (!this._batch)
            this._onChanged(this._displays);
    }

    destroy() {
        if (this._pollTimer)
            GLib.Source.remove(this._pollTimer);
        this._monitorManager.disconnectObject(this);
        Main.brightnessManager.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._destroyDevices();
    }
}

const BrightnessPanel = GObject.registerClass(
class BrightnessPanel extends QuickSlider {
    _init(owner, service) {
        super._init({
            iconName: 'display-brightness-symbolic',
            iconLabel: _('Overall display brightness'),
            menuEnabled: true,
            menuButtonAccessibleName: _('Open display brightness menu'),
        });
        this._owner = owner;
        this._service = service;
        this._settings = owner.settings;
        this._devices = [];
        this.slider.accessible_name = _('Overall brightness for all displays');
        this.slider.connect('notify::value', () => {
            if (!this._syncingMainSlider)
                this._service.setGlobalBrightness(this._brightnessAtSliderPosition(this.slider.value));
        });

        this._mainPercentage = new St.Label({text: '100%', style_class: 'dim-label'});
        this._mainPercentage.accessible_name = _('Brightness percentage');

        this._resetButton = new St.Button({
            label: '100%',
            style_class: 'button',
            style: 'min-width: 40px; max-width: 40px; min-height: 40px; max-height: 40px; padding: 0; border-radius: 20px; font-size: 9pt;',
            can_focus: true,
            accessible_name: _('Set overall brightness to 100 percent'),
        });
        this._resetButton.connect('clicked', () => this._service.setGlobalBrightness(1));
        // QuickSlider supplies GNOME's themed slider and compact menu arrow.
        // Insert the reset action immediately before that arrow.
        const controls = this.get_child();
        const arrowIndex = controls.get_n_children() - 1;
        controls.insert_child_at_index(this._mainPercentage, arrowIndex);
        controls.insert_child_at_index(this._resetButton, arrowIndex + 1);
        owner.settings.connectObject('changed::show-percentage', () => this._syncMenu(this._devices), this);
        owner.settings.connectObject('changed::minimum-brightness', () => this.update(this._devices), this);

        this.menu.setHeader('display-brightness-symbolic', _('Overall display brightness'));
        this._deviceSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._deviceSection);
        this.menu.connect('open-state-changed', (_menu, open) => this._service.setMenuOpen(open));
        this._syncMenu([]);
    }

    update(devices) {
        this._devices = devices;
        const value = this._service.globalBrightness;
        this._syncingMainSlider = true;
        this.slider.value = this._sliderPositionForBrightness(value);
        this._syncingMainSlider = false;
        this._resetButton.reactive = devices.length > 0;
        this._resetButton.can_focus = devices.length > 0;
        this._mainPercentage.text = `${Math.round(value * 100)}%`;
        this._mainPercentage.visible = this._settings.get_boolean('show-percentage');
        this._syncMenu(devices);
    }

    _syncMenu(devices) {
        this._mainPercentage.visible = this._settings.get_boolean('show-percentage');
        const signature = devices.map(device => device.id).join(';');
        if (signature !== this._menuSignature) {
            this._menuSignature = signature;
            this._deviceSection.removeAll();
            this._controls = new Map();
            if (devices.length === 0) {
                const empty = new PopupMenu.PopupMenuItem(_('No active displays'), {reactive: false});
                this._deviceSection.addMenuItem(empty);
                return;
            }
            for (const device of devices)
                this._addDisplayControls(device);
        }

        for (const device of devices) {
            const control = this._controls.get(device.id);
            if (!control)
                continue;
            const value = device.requestedValue ?? device.value;
            control.percentage.text = `${Math.round(value * 100)}%`;
            control.percentage.visible = this._settings.get_boolean('show-percentage');
            control.method.text = this._methodLabel(device, device.requestedValue !== undefined && device.requestedValue !== null);
            if (!control.adjusting) {
                this._syncingMenuSlider = true;
                control.slider.value = this._sliderPositionForBrightness(value);
                this._syncingMenuSlider = false;
            }
            control.error.text = device.error;
            control.error.visible = Boolean(device.error);
            control.errorItem.visible = Boolean(device.error);
        }
    }

    _methodLabel(device, pending = false) {
        const method = device.ddc ? _('DDC/CI monitor brightness')
            : device.backend === 'mutter' ? _('System brightness control')
                : _('Software dimming');
        return pending ? `${method} · ${_('Applying…')}` : method;
    }

    _addDisplayControls(device) {
        const title = new PopupMenu.PopupMenuItem(device.name, {reactive: false});
        this._deviceSection.addMenuItem(title);

        const info = new St.BoxLayout({x_expand: true});
        const method = new St.Label({
            text: this._methodLabel(device, device.requestedValue !== undefined && device.requestedValue !== null),
            style_class: 'dim-label',
            x_expand: true,
        });
        const percentage = new St.Label({text: `${Math.round((device.requestedValue ?? device.value) * 100)}%`, style_class: 'dim-label'});
        percentage.visible = this._settings.get_boolean('show-percentage');
        info.add_child(method);
        info.add_child(percentage);
        const infoItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
        infoItem.add_child(info);
        this._deviceSection.addMenuItem(infoItem);

        const slider = new Slider(this._sliderPositionForBrightness(device.requestedValue ?? device.value));
        slider.accessible_name = _('Brightness for %s').format(device.name);
        const sliderBin = new St.Bin({
            style_class: 'slider-bin',
            child: slider,
            reactive: true,
            can_focus: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const reset = new St.Button({
            label: '100%',
            style_class: 'button',
            style: 'min-width: 40px; max-width: 40px; min-height: 40px; max-height: 40px; padding: 0; border-radius: 20px; font-size: 9pt;',
            can_focus: true,
            accessible_name: _('Set %s to 100 percent').format(device.name),
        });
        reset.connect('clicked', () => this._service.setBrightness(device.id, 1));
        const sliderItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
        sliderItem.add_child(sliderBin);
        sliderItem.add_child(reset);
        this._deviceSection.addMenuItem(sliderItem);

        const error = new St.Label({text: '', style_class: 'dim-label', visible: false});
        const errorItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
        errorItem.visible = false;
        errorItem.add_child(error);
        this._deviceSection.addMenuItem(errorItem);
        this._deviceSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const control = {slider, method, percentage, error, errorItem, adjusting: false};
        this._controls.set(device.id, control);
        slider.connect('drag-begin', () => control.adjusting = true);
        slider.connect('drag-end', () => {
            control.adjusting = false;
            this._service.setBrightness(device.id, this._brightnessAtSliderPosition(slider.value));
        });
        slider.connect('notify::value', () => {
            if (!this._syncingMenuSlider && !control.adjusting)
                this._service.setBrightness(device.id, this._brightnessAtSliderPosition(slider.value));
        });
    }

    _minimumBrightness() {
        return this._settings.get_int('minimum-brightness');
    }

    _sliderPositionForBrightness(value) {
        return brightnessToSliderPosition(value, this._minimumBrightness());
    }

    _brightnessAtSliderPosition(position) {
        return sliderPositionToBrightness(position, this._minimumBrightness());
    }
});

const Indicator = GObject.registerClass(
class Indicator extends SystemIndicator {
    _init(extension) {
        super._init();
        this.panel = new BrightnessPanel(extension, extension.service);
        this.quickSettingsItems.push(this.panel);
    }
});

export default class LumaExtension extends Extension {
    enable() {
        this.settings = this.getSettings();
        this._brightnessIndicator = null;
        this._brightnessItems = [];
        this._hideNativeBrightness();
        this.service = new BrightnessService(this.settings, devices => this._indicator?.panel.update(devices));
        this._indicator = new Indicator(this);
        this._indicator.panel.visible = false;
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
        this._quickSettingsMenu = Main.panel.statusArea.quickSettings.menu;
        this._quickSettingsMenu.connectObject('open-state-changed', (_menu, open) => this.service?.setMenuOpen(open), this);
        this._schedulePanelPlacement();
    }

    _schedulePanelPlacement() {
        if (this._placementTimer)
            GLib.Source.remove(this._placementTimer);
        this._placementAttempts = 0;
        this._placementTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            if (this._placeAfterVolume()) {
                this._placementTimer = 0;
                return GLib.SOURCE_REMOVE;
            }
            if (++this._placementAttempts < 100)
                return GLib.SOURCE_CONTINUE;

            // GNOME creates the volume items asynchronously. If no microphone
            // control was created, the output control still anchors the row.
            if (!this._placeAfterVolume(true))
                this._indicator.panel.visible = true;
            this._placementTimer = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    _placeAfterVolume(allowPartial = false) {
        const quickSettings = Main.panel.statusArea.quickSettings;
        this._hideNativeBrightness();
        const menu = quickSettings?.menu;
        const grid = menu?._grid;
        const item = this._indicator?.panel;
        if (!grid || !item)
            return false;

        const output = [...(quickSettings._volumeOutput?.quickSettingsItems ?? [])];
        const input = [...(quickSettings._volumeInput?.quickSettingsItems ?? [])];
        const children = grid.get_children();
        const outputItems = output.filter(control => children.includes(control));
        const inputItems = input.filter(control => children.includes(control));
        if (outputItems.length === 0 || (!allowPartial && input.length > 0 && inputItems.length !== input.length))
            return false;

        // addExternalIndicator() has already registered the item with the menu.
        // Reorder that existing grid child instead of registering its menu twice.
        if (item.get_parent() !== grid)
            return false;

        const volumeItems = [...outputItems, ...inputItems];
        const lastIndex = Math.max(...volumeItems.map(control => children.indexOf(control)));
        const sibling = children.slice(lastIndex + 1).find(child => child !== item);
        grid.layout_manager.child_set_property(grid, item, 'column-span', 2);
        if (sibling)
            grid.set_child_below_sibling(item, sibling);
        else if (children.at(-1) !== item)
            grid.set_child_above_sibling(item, children.at(-1));
        item.visible = true;
        return true;
    }

    _hideNativeBrightness() {
        if (!this._brightnessIndicator) {
            const indicator = Main.panel.statusArea.quickSettings._brightness;
            if (!indicator)
                return false;
            this._brightnessIndicator = indicator;
            this._previousVisibility = indicator.visible;
            this._brightnessItems = [...(indicator.quickSettingsItems ?? [])]
                .map(item => [item, item.visible]);
        }
        this._brightnessIndicator.visible = false;
        for (const [item] of this._brightnessItems)
            item.visible = false;
        return true;
    }

    disable() {
        if (this._placementTimer)
            GLib.Source.remove(this._placementTimer);
        this._placementTimer = 0;
        this._quickSettingsMenu?.disconnectObject(this);
        this._quickSettingsMenu = null;
        this.service?.destroy();
        this.service = null;
        const menu = Main.panel.statusArea.quickSettings.menu;
        const item = this._indicator?.panel;
        if (item?.get_parent() === menu?._grid)
            menu._grid.remove_child(item);
        this._indicator?.destroy();
        this._indicator = null;
        if (this._brightnessIndicator)
            this._brightnessIndicator.visible = this._previousVisibility;
        for (const [item, visible] of this._brightnessItems ?? [])
            item.visible = visible;
        this._brightnessIndicator = null;
        this.settings = null;
    }
}
