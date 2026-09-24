// Workspace buttons in place of Activities, as in Omarchy's bar.
// Adapted from Simple Workspaces Bar (GPL-3.0; Francois Thirioux, null-git;
// https://gitlab.com/null-git/simple-workspaces-bar). Unlike the original,
// buttons persist and only change style, and emptiness follows each
// workspace's window-added/removed rather than every restack.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const NAMES_SCHEMA = 'org.gnome.desktop.wm.preferences';

export class Workspaces {
    enable() {
        this._button = new PanelMenu.Button(0.0, 'Workspaces', true);
        this._button.track_hover = false;
        this._button.add_style_class_name('jade-workspaces');
        this._box = new St.BoxLayout();
        this._button.add_child(this._box);
        // Torn down with the Shell at logout (no disable() then): stop listening.
        this._box.connect('destroy', () => {
            this._disconnectWorkspaces();
            for (const id of this._managerSignals ?? [])
                global.workspace_manager.disconnect(id);
            this._managerSignals = null;
            this._box = null;
        });
        this._button.connect('scroll-event', (_a, event) => this._onScroll(event));
        this._workspaceSignals = [];

        this._names = new Gio.Settings({schema_id: NAMES_SCHEMA});
        this._namesChanged = this._names.connect('changed::workspace-names', () => this._rebuild());
        const manager = global.workspace_manager;
        this._managerSignals = [
            manager.connect('active-workspace-changed', () => this._restyle()),
            manager.connect('notify::n-workspaces', () => this._rebuild()),
            manager.connect('workspaces-reordered', () => this._rebuild()),
        ];

        this._activities = Main.panel.statusArea.activities;
        this._activities?.container.hide();
        Main.panel.addToStatusArea('jade-workspaces', this._button, 0, 'left');
        this._rebuild();
    }

    // Also undoes an enable() that failed partway: Activities comes back first.
    disable() {
        if (!Main.sessionMode.isLocked)
            this._activities?.container.show();
        this._activities = null;
        this._disconnectWorkspaces();
        for (const id of this._managerSignals ?? [])
            global.workspace_manager.disconnect(id);
        this._managerSignals = null;
        if (this._namesChanged)
            this._names.disconnect(this._namesChanged);
        this._names = this._namesChanged = null;
        this._button?.destroy();
        this._button = this._box = null;
    }

    _disconnectWorkspaces() {
        for (const [workspace, ids] of this._workspaceSignals ?? [])
            ids.forEach(id => workspace.disconnect(id));
        this._workspaceSignals = [];
    }

    _rebuild() {
        if (!this._box)
            return;
        this._disconnectWorkspaces();
        this._box.destroy_all_children();
        const names = this._names.get_strv('workspace-names');
        const manager = global.workspace_manager;
        for (let i = 0; i < manager.get_n_workspaces(); i++) {
            const workspace = manager.get_workspace_by_index(i);
            const button = new St.Button({
                label: names[i] || String(i + 1), style_class: 'jade-workspace',
                can_focus: true, track_hover: true, y_align: Clutter.ActorAlign.CENTER,
                accessible_name: `Workspace ${i + 1}`,
            });
            button.connect('clicked', () => this._activate(workspace));
            this._box.add_child(button);
            this._workspaceSignals.push([workspace, [
                workspace.connect('window-added', () => this._restyle()),
                workspace.connect('window-removed', () => this._restyle()),
            ]]);
        }
        this._restyle();
    }

    _restyle() {
        if (!this._box)
            return;
        const manager = global.workspace_manager;
        const active = manager.get_active_workspace_index();
        this._box.get_children().forEach((button, i) => {
            const workspace = manager.get_workspace_by_index(i);
            const occupied = workspace?.list_windows().some(w => !w.skip_taskbar) ?? false;
            button[i === active ? 'add_style_class_name' : 'remove_style_class_name']('active');
            button[occupied ? 'add_style_class_name' : 'remove_style_class_name']('occupied');
        });
    }

    // Clicking the current workspace toggles the overview, like Activities.
    _activate(workspace) {
        if (workspace.active)
            Main.overview.toggle();
        else
            workspace.activate(global.get_current_time());
    }

    _onScroll(event) {
        const direction = event.get_scroll_direction();
        const step = {[Clutter.ScrollDirection.UP]: -1, [Clutter.ScrollDirection.DOWN]: 1}[direction];
        if (step === undefined)
            return Clutter.EVENT_PROPAGATE;
        const manager = global.workspace_manager;
        const target = manager.get_active_workspace_index() + step;
        if (target >= 0 && target < manager.get_n_workspaces())
            manager.get_workspace_by_index(target).activate(global.get_current_time());
        return Clutter.EVENT_STOP;
    }
}
