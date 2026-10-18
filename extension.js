import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {QuickSettingsItem, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {normalizeBrightness, parseDdcDetection, parseDdcReading, retryDelay,
    sameDisplayedPercent, selectBrightnessBackend} from './brightness-model.js';

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
        this.pendingValue = null;
        this.lastValue = null;
        this.failures = 0;
        this.nextRetryAt = 0;
        this.maximum = null;
        this.onChange = null;
        this.onFailure = null;
        this.destroyed = false;
    }

    set(value) {
        this._requestedNormalized = finite(value);
        this.pendingValue = Math.round(this._requestedNormalized * (this.maximum || 100));
        this.failures = 0;
        this.nextRetryAt = 0;
        this._scheduleWrite(DDC_DEBOUNCE_MS);
    }

    _scheduleWrite(delay) {
        if (this.timer || this.process || this.destroyed || this.paused || this.pendingValue === null)
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

    async read() {
        if (this.process || this.destroyed || this.paused || Date.now() < this.nextRetryAt)
            return;
        const result = await this._run(['getvcp', '10']);
        if (result === null) {
            this._failed();
            return;
        }
        const reading = parseDdcReading(result);
        if (!reading) {
            this._failed();
            return;
        }
        this.failures = 0;
        this.nextRetryAt = 0;
        this.maximum = reading.maximum;
        this.lastValue = reading.value;
        this.onChange?.(this.lastValue);
    }

    async _write() {
        if (this.pendingValue === null || this.process || this.destroyed)
            return;
        if (!this.maximum) {
            await this.read();
            if (!this.maximum) {
                this._scheduleWrite(retryDelay(Math.max(1, this.failures)));
                return;
            }
        }
        this.pendingValue = Math.round(this._requestedNormalized * this.maximum);
        const value = this.pendingValue;
        this.pendingValue = null;
        const result = await this._run(['setvcp', '10', String(value)]);
        if (result === null) {
            this.pendingValue = value;
            this._scheduleWrite(retryDelay(Math.max(1, this.failures)));
        } else {
            // A write request is not confirmation; read the monitor's actual value.
            await this.read();
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
        this.pendingValue = null;
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
        let ddcMap = new Map();
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
                const ddc = ddcMap.get(connector);
                const nativeScale = Main.brightnessManager.scales.find(s => s.monitor === logical);
                const backend = selectBrightnessBackend({backlight, nativeScale, ddc: ddcMap.has(connector)});
                const value = backlight
                    ? normalizeBrightness(backlight.brightness, backlight.brightnessMin, backlight.brightnessMax)
                    : nativeScale?.value;
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
                        device.requestedValue = null;
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
        value = finite(value);
        if (device.ddc) {
            device.error = '';
            device.requestedValue = value;
            device.ddc.set(value);
            this._emit();
            return;
        }
        if (device.backend === 'mutter' && device.backlight) {
            const {brightnessMin, brightnessMax} = device.backlight;
            device.backlight.brightness = Math.round(brightnessMin + value * (brightnessMax - brightnessMin));
            device.requestedValue = value;
        } else if (device.backend === 'mutter' && device.nativeScale) {
            device.requestedValue = value;
            device.nativeScale.value = value;
        } else {
            // Software dimming is explicitly shown in the UI and never changes the reported hardware level.
            device.softwareValue = value;
            device.value = value;
            this._setOverlay(device, value);
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
class BrightnessPanel extends QuickSettingsItem {
    _init(owner, service) {
        super._init({style_class: 'quick-settings-system-item'});
        this._owner = owner;
        this._service = service;
        this._devices = [];
        this._expanded = owner.settings.get_boolean('expanded');
        this._rows = new St.BoxLayout({vertical: true, style_class: 'quick-settings-grid'});
        this.set_child(this._rows);
        this.connect('notify::visible', () => this._service.setMenuOpen(this.visible));
        this._render([]);
    }

    update(devices) { this._render(devices); }

    _render(devices) {
        this._devices = devices;
        if (!devices.length) {
            if (this._layout !== 'empty') {
                this._rows.destroy_all_children();
                this._rows.add_child(new St.Label({text: _('No active displays'), style_class: 'dim-label'}));
                this._layout = 'empty';
            }
            return;
        }
        const adjusted = devices.map(d => ({...d, value: d.requestedValue ?? d.value}));
        const same = sameDisplayedPercent(adjusted);
        const sharedAdjusting = this._layout?.startsWith('shared:') && this._controls?.get('shared')?.adjusting;
        if (!same && !sharedAdjusting)
            this._expanded = true;
        const collapsed = (same && !this._expanded) || sharedAdjusting;
        const layout = `${collapsed ? 'shared' : 'individual'}:${devices.map(d => d.id).join(';')}`;
        if (layout !== this._layout) {
            this._rows.destroy_all_children();
            this._controls = new Map();
            this._layout = layout;
            if (collapsed) {
                this._addSliderRow(_('Display brightness'), adjusted[0].value,
                    value => this._service.setAll(value), true, _('All displays'));
            } else {
                for (const device of devices)
                    this._addSliderRow(device.name, device.requestedValue ?? device.value,
                        value => this._service.setBrightness(device.id, value), false,
                        device.ddc ? _('DDC/CI') : device.backend === 'mutter' ? _('Hardware backlight') : _('Software dimming'), device.id);
                if (same) {
                    const collapse = new St.Button({label: _('Collapse'), style_class: 'button', x_expand: true});
                    collapse.connect('clicked', () => {
                        this._expanded = false;
                        this._owner.settings.set_boolean('expanded', false);
                        this._render(this._devices);
                    });
                    this._rows.add_child(collapse);
                }
            }
        }
        for (const device of devices) {
            const control = this._controls.get(collapsed ? 'shared' : device.id);
            if (!control || control.adjusting)
                continue;
            const value = collapsed ? (devices[0].requestedValue ?? devices[0].value) : (device.requestedValue ?? device.value);
            control.slider.value = value;
            control.percentage.text = `${Math.round(value * 100)}%`;
        }
    }

    _addSliderRow(name, value, onChange, shared, method, id = 'shared') {
        const head = new St.BoxLayout({x_expand: true});
        head.add_child(new St.Label({text: name, x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        if (!shared)
            head.add_child(new St.Label({text: method, style_class: 'dim-label', y_align: Clutter.ActorAlign.CENTER}));
        const percentage = new St.Label({text: `${Math.round(value * 100)}%`, style_class: 'dim-label', y_align: Clutter.ActorAlign.CENTER});
        head.add_child(percentage);
        if (shared) {
            const expand = new St.Button({child: new St.Icon({icon_name: 'go-down-symbolic'}), style_class: 'button', can_focus: true, accessible_name: _('Show individual displays')});
            expand.connect('clicked', () => {
                this._expanded = true;
                this._owner.settings.set_boolean('expanded', true);
                this._render(this._devices);
            });
            head.add_child(expand);
        }
        this._rows.add_child(head);
        const line = new St.BoxLayout({x_expand: true, style_class: 'quick-settings-slider'});
        line.add_child(new St.Icon({icon_name: 'display-brightness-symbolic', style_class: 'quick-settings-slider-icon'}));
        const slider = new Slider(value);
        slider.accessible_name = name;
        slider.x_expand = true;
        const control = {slider, percentage, adjusting: false};
        slider.connect('drag-begin', () => control.adjusting = true);
        slider.connect('drag-end', () => {
            control.adjusting = false;
            onChange(slider.value);
            this._render(this._devices);
        });
        slider.connect('notify::value', () => {
            if (!control.adjusting)
                onChange(slider.value);
        });
        this._controls.set(id, control);
        line.add_child(slider);
        const reset = new St.Button({label: '100%', style_class: 'button', can_focus: true, accessible_name: _('Set %s to 100 percent').format(name)});
        reset.connect('clicked', () => onChange(1));
        line.add_child(reset);
        this._rows.add_child(line);
        const device = this._devices.find(candidate => candidate.id === id);
        if (!shared && device?.error)
            this._rows.add_child(new St.Label({text: device.error, style_class: 'dim-label'}));
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
