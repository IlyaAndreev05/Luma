import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class LumaPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.title = _('Luma — Display Brightness');
        window.default_width = 520;
        window.default_height = 390;
        const page = new Adw.PreferencesPage({title: _('Brightness'), icon_name: 'display-brightness-symbolic'});
        const group = new Adw.PreferencesGroup({title: _('Behavior')});
        const restore = new Adw.SwitchRow({title: _('Restore saved brightness'), subtitle: _('Apply the last confirmed level when a known display reconnects.')});
        settings.bind('restore-brightness', restore, 'active', Gio.SettingsBindFlags.DEFAULT);
        const expand = new Adw.SwitchRow({title: _('Start with individual sliders'), subtitle: _('Open the display list when all screens are at the same level.')});
        settings.bind('expanded', expand, 'active', Gio.SettingsBindFlags.DEFAULT);
        const poll = new Adw.SpinRow({title: _('DDC/CI refresh interval'), subtitle: _('Seconds between checks while Quick Settings is closed.'), adjustment: new Gtk.Adjustment({lower: 2, upper: 60, step_increment: 1, page_increment: 5})});
        settings.bind('ddc-refresh-seconds', poll, 'value', Gio.SettingsBindFlags.DEFAULT);
        const showPercentage = new Adw.SwitchRow({title: _('Show brightness percentage'), subtitle: _('Display the current percentage in the panel and display list.')});
        settings.bind('show-percentage', showPercentage, 'active', Gio.SettingsBindFlags.DEFAULT);
        const minimum = new Adw.SpinRow({
            title: _('Minimum brightness'),
            subtitle: _('The lowest slider position stays above black to keep the screen visible.'),
            adjustment: new Gtk.Adjustment({value: settings.get_int('minimum-brightness'), lower: 2, upper: 20, step_increment: 1, page_increment: 2}),
        });
        settings.bind('minimum-brightness', minimum, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(restore);
        group.add(expand);
        group.add(poll);
        group.add(showPercentage);
        group.add(minimum);
        page.add(group);
        window.add(page);
    }
}
