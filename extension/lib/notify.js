import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

// A notification from Jade Shell with buttons: [[label, callback], ...].
// Each gets its own source, which GNOME removes with its last notification.
export function notify(title, body, actions = [], iconName = 'preferences-desktop-appearance-symbolic') {
    const source = new MessageTray.Source({title: 'Jade Shell', icon: new Gio.ThemedIcon({name: iconName})});
    Main.messageTray.add(source);
    const notification = new MessageTray.Notification({source, title, body});
    for (const [label, callback] of actions)
        notification.addAction(label, callback);
    source.addNotification(notification);
    return notification;
}

export function openUri(uri) {
    try {
        Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
    } catch (e) {
        console.error(`Jade Shell: could not open ${uri}: ${e.message}`);
    }
}
