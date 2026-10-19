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
import {clampBrightnessToMinimum, normalizeBrightness, parseDdcDetection, parseDdcReading, retryDelay,
    DdcWriteQueue, matchDdcDisplay, selectBrightnessBackend} from './brightness-model.js';

const DDC_TIMEOUT_MS = 3000;
const DDC_DEBOUNCE_MS = 100;
function finite(value, fallback = 1) {
    return Number.isFinite(value) ? Math.clamp(value, 0, 1) : fallback;
}

class DdcController {
    constructor(connector, bus) {
        this.connector = connector;
        this.bus = bus;
        this.process = null;
        this.timer = 0;
        this.writeQueue = new DdcWriteQueue();
        this.lastValue = null;
        this.failures = 0;
        this.nextRetryAt = 0;
        this.maximum = null;
        this.onChange = null;
        this.onFailure = null;
        this.destroyed = false;
    }

    set(value) {
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
        this.process?.force_exit();
    }

    resume() {
        this.paused = false;
        this._scheduleWrite(DDC_DEBOUNCE_MS);
    }

    async read({allowPending = false, schedulePending = true} = {}) {
        if (this.process || this.destroyed || this.paused || Date.now() < this.nextRetryAt)
            return;
        if (this.writeQueue.hasPending && !allowPending)
            return;
        const generation = this.writeQueue.generation;
        try {
            const result = await this._run(['getvcp', '10']);
            if (result === null) {
                if (this.writeQueue.isLatest(generation) && (allowPending || !this.writeQueue.hasPending))
                    this._failed();
                return;
            }
            const reading = parseDdcReading(result);
            if (!reading) {
                if (this.writeQueue.isLatest(generation) && (allowPending || !this.writeQueue.hasPending))
                    this._failed();
                return;
            }
            this.failures = 0;
            this.nextRetryAt = 0;
            this.maximum = reading.maximum;
            this.lastValue = reading.value;
            // A poll that began before a newer request must never move its slider back.
            if (this.writeQueue.canPublish(generation))
                this.onChange?.(this.lastValue);
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
            // A write request is not confirmation; read the monitor's actual value.
            await this.read({schedulePending: false});
        }
        this._scheduleWrite(DDC_DEBOUNCE_MS);
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
        this.process?.force_exit();
        this.process = null;
        this.writeQueue.clear();
        this.onChange = null;
        this.onFailure = null;
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
        this._monitorManager.connectObject('monitors-changed', () => this.refresh(), this);
        Main.brightnessManager.connectObject('changed', () => this.refresh(), this);
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
                    error: '',
                };
                if (device.ddc) {
                    device.ddc.onChange = actual => {
                        device.value = actual;
                        device.requestedValue = null;
                        device.error = '';
                        this._saveConfirmed(device);
                        this._emit();
                    };
                    device.ddc.onFailure = () => {
                        device.error = _('Could not read or apply monitor brightness; check DDC/CI and device access.');
                        this._emit();
                    };
                }
                this._displays.push(device);
                if (this._settings.get_boolean('restore-brightness')) {
                    const saved = this._settings.get_value('saved-brightness').deep_unpack();
                    if (saved[device.id] !== undefined)
                        this.setBrightness(device.id, saved[device.id]);
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
        value = clampBrightnessToMinimum(finite(value), this._settings.get_int('minimum-brightness'));
        const deviceValue = value;
        if (device.ddc) {
            device.error = '';
            device.requestedValue = value;
            device.ddc.set(deviceValue);
            this._emit();
            return;
        }
        if (device.backend === 'mutter' && device.backlight) {
            const {brightnessMin, brightnessMax} = device.backlight;
            device.backlight.brightness = Math.round(brightnessMin + deviceValue * (brightnessMax - brightnessMin));
            device.requestedValue = value;
        } else if (device.backend === 'mutter' && device.nativeScale) {
            device.requestedValue = value;
            device.nativeScale.value = deviceValue;
        } else {
            // Software dimming is explicitly shown in the UI and never changes the reported hardware level.
            device.softwareValue = value;
            device.value = value;
            this._setOverlay(device, deviceValue);
            this._saveConfirmed(device);
        }
        this._emit();
    }

    _setOverlay(device, value) {
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

    setAll(value) {
        this._batch = true;
        this._displays.forEach(d => this.setBrightness(d.id, value));
        this._batch = false;
        this._emit();
    }

    _saveConfirmed(device) {
        const saved = this._settings.get_value('saved-brightness').deep_unpack();
        saved[device.id] = device.value;
        this._settings.set_value('saved-brightness', new GLib.Variant('a{sd}', saved));
    }

    _readNative() {
        for (const device of this._displays) {
            if (device.backlight) {
                const {brightness, brightnessMin, brightnessMax} = device.backlight;
                device.value = normalizeBrightness(brightness, brightnessMin, brightnessMax) ?? device.value;
                device.requestedValue = null;
                this._saveConfirmed(device);
            } else if (device.nativeScale) {
                device.value = finite(device.nativeScale.value);
                device.requestedValue = null;
                this._saveConfirmed(device);
            }
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
        this._destroyDevices();
    }
}

const BrightnessPanel = GObject.registerClass(
class BrightnessPanel extends QuickSlider {
    _init(owner, service) {
        super._init({
            iconName: 'display-brightness-symbolic',
            iconLabel: _('Display brightness'),
            menuEnabled: true,
            menuButtonAccessibleName: _('Open display brightness menu'),
        });
        this._owner = owner;
        this._service = service;
        this._settings = owner.settings;
        this._devices = [];
        this.slider.accessible_name = _('Brightness for all displays');
        this.slider.connect('notify::value', () => {
            if (!this._syncingMainSlider)
                this._service.setAll(this.slider.value);
        });

        this._mainPercentage = new St.Label({text: '100%', style_class: 'dim-label'});
        this._mainPercentage.accessible_name = _('Brightness percentage');

        this._resetButton = new St.Button({
            label: '100%',
            style_class: 'button',
            style: 'min-width: 40px; max-width: 40px; min-height: 40px; max-height: 40px; padding: 0; border-radius: 20px; font-size: 9pt;',
            can_focus: true,
            accessible_name: _('Set all displays to 100 percent'),
        });
        this._resetButton.connect('clicked', () => this._service.setAll(1));
        // QuickSlider supplies GNOME's themed slider and compact menu arrow.
        // Insert the reset action immediately before that arrow.
        const controls = this.get_child();
        const arrowIndex = controls.get_n_children() - 1;
        controls.insert_child_at_index(this._mainPercentage, arrowIndex);
        controls.insert_child_at_index(this._resetButton, arrowIndex + 1);
        owner.settings.connectObject('changed::show-percentage', () => this._syncMenu(this._devices), this);

        this.menu.setHeader('display-brightness-symbolic', _('Display brightness'));
        this._deviceSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._deviceSection);
        this.menu.connect('open-state-changed', (_menu, open) => this._service.setMenuOpen(open));
        this._syncMenu([]);
    }

    update(devices) {
        this._devices = devices;
        const values = devices.map(device => device.requestedValue ?? device.value);
        const value = values.length ? values.reduce((sum, current) => sum + current, 0) / values.length : 1;
        this._syncingMainSlider = true;
        this.slider.value = value;
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
            control.method.text = this._methodLabel(device);
            if (!control.adjusting) {
                this._syncingMenuSlider = true;
                control.slider.value = value;
                this._syncingMenuSlider = false;
            }
            control.error.text = device.error;
            control.error.visible = Boolean(device.error);
            control.errorItem.visible = Boolean(device.error);
        }
    }

    _methodLabel(device) {
        return device.ddc ? _('DDC/CI monitor brightness')
            : device.backend === 'mutter' ? _('System brightness control')
                : _('Software dimming');
    }

    _addDisplayControls(device) {
        const title = new PopupMenu.PopupMenuItem(device.name, {reactive: false});
        this._deviceSection.addMenuItem(title);

        const info = new St.BoxLayout({x_expand: true});
        const method = new St.Label({text: this._methodLabel(device), style_class: 'dim-label', x_expand: true});
        const percentage = new St.Label({text: `${Math.round((device.requestedValue ?? device.value) * 100)}%`, style_class: 'dim-label'});
        percentage.visible = this._settings.get_boolean('show-percentage');
        info.add_child(method);
        info.add_child(percentage);
        const infoItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
        infoItem.add_child(info);
        this._deviceSection.addMenuItem(infoItem);

        const slider = new Slider(device.requestedValue ?? device.value);
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
            this._service.setBrightness(device.id, slider.value);
        });
        slider.connect('notify::value', () => {
            if (!this._syncingMenuSlider && !control.adjusting)
                this._service.setBrightness(device.id, slider.value);
        });
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
        this._brightnessIndicator = Main.panel.statusArea.quickSettings._brightness;
        this._previousVisibility = this._brightnessIndicator?.visible ?? false;
        this._brightnessItems = [...(this._brightnessIndicator?.quickSettingsItems ?? [])].map(item => [item, item.visible]);
        if (this._brightnessIndicator)
            this._brightnessIndicator.visible = false;
        for (const [item] of this._brightnessItems)
            item.visible = false;
        this.service = new BrightnessService(this.settings, devices => this._indicator?.panel.update(devices));
        this._indicator = new Indicator(this);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
        this._placeAfterVolume();
        this._quickSettingsMenu = Main.panel.statusArea.quickSettings.menu;
        this._quickSettingsMenu.connectObject('open-state-changed', (_menu, open) => this.service?.setMenuOpen(open), this);
        this._monitorManager = global.backend.get_monitor_manager();
        this._monitorManager.connectObject('monitors-changed', () => this._placeAfterVolume(), this);
    }

    _placeAfterVolume() {
        const menu = Main.panel.statusArea.quickSettings.menu;
        const grid = menu?._grid;
        const item = this._indicator?.panel;
        if (!grid || !item)
            return;
        const volumes = [
            ...Main.panel.statusArea.quickSettings._volumeOutput?.quickSettingsItems ?? [],
            ...Main.panel.statusArea.quickSettings._volumeInput?.quickSettingsItems ?? [],
        ];
        const children = grid.get_children();
        const lastIndex = Math.max(-1, ...volumes.map(v => children.indexOf(v)));
        const sibling = children[lastIndex + 1];
        if (sibling && sibling !== item) {
            grid.remove_child(item);
            menu.insertItemBefore(item, sibling, 2);
        } else if (!sibling && children.at(-1) !== item) {
            grid.remove_child(item);
            menu.addItem(item, 2);
        }
    }

    disable() {
        this._monitorManager?.disconnectObject(this);
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
