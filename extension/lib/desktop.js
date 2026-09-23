// Small changes to GNOME's own behavior: start on the desktop instead of the
// overview, and a denser app grid. Both follow the approach of extensions
// that have done it for years (Just Perfection and App Grid Tuner, GPL-3.0)
// and put everything back on disable.
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as OverviewControls from 'resource:///org/gnome/shell/ui/overviewControls.js';

export class Desktop {
    constructor(settings) {
        this._settings = settings;
    }

    enable() {
        this._startOnDesktop();
        this._gridChanged = ['app-grid-columns', 'app-grid-rows', 'app-grid-icon-size'].map(
            key => this._settings.connect(`changed::${key}`, () => this._applyGrid()));
        // The app grid picks its own layout while the Shell starts; ours goes on after.
        if (Main.layoutManager._startingUp)
            this._gridAfterStartup = Main.layoutManager.connect('startup-complete', () => this._applyGrid());
        else
            this._applyGrid();
    }

    disable() {
        if (this._startupComplete) {
            Main.layoutManager.disconnect(this._startupComplete);
            Main.sessionMode.hasOverview = this._hadOverview;
        }
        this._startupComplete = null;
        if (this._gridAfterStartup)
            Main.layoutManager.disconnect(this._gridAfterStartup);
        this._gridAfterStartup = null;
        this._gridChanged.forEach(id => this._settings.disconnect(id));
        this._restoreGrid();
    }

    // With no overview during start-up, GNOME plays its desktop zoom-in
    // instead of opening the overview (layout.js checks hasOverview).
    _startOnDesktop() {
        if (!Main.layoutManager._startingUp || !this._settings.get_boolean('start-on-desktop'))
            return;
        this._hadOverview = Main.sessionMode.hasOverview;
        Main.sessionMode.hasOverview = false;
        Main.layoutManager.startInOverview = false;
        Main.overview._overview.controls._stateAdjustment.value = OverviewControls.ControlsState.HIDDEN;
        this._startupComplete = Main.layoutManager.connect('startup-complete', () => {
            Main.sessionMode.hasOverview = this._hadOverview;
            Main.layoutManager.disconnect(this._startupComplete);
            this._startupComplete = null;
        });
    }

    _grid() {
        return Main.overview._overview?.controls?._appDisplay?._grid ?? null;
    }

    _applyGrid() {
        if (this._gridAfterStartup) {
            Main.layoutManager.disconnect(this._gridAfterStartup);
            this._gridAfterStartup = null;
        }
        const grid = this._grid();
        const columns = this._settings.get_int('app-grid-columns');
        const rows = this._settings.get_int('app-grid-rows');
        if (!grid?.layout_manager || !grid.setGridModes)
            return;
        if (!this._originalGrid) {
            this._originalGrid = {
                modes: grid._gridModes?.map(mode => ({...mode})),
                fixedIconSize: grid.layout_manager.fixedIconSize,
            };
        }
        if (columns > 0 && rows > 0)
            grid.setGridModes([{rows, columns}]);
        else if (this._originalGrid.modes)
            grid.setGridModes(this._originalGrid.modes);
        const size = this._settings.get_int('app-grid-icon-size');
        grid.layout_manager.fixedIconSize = size > 0 ? size : this._originalGrid.fixedIconSize;
        this._relayout();
    }

    _restoreGrid() {
        const grid = this._grid();
        if (!this._originalGrid || !grid?.layout_manager)
            return;
        if (this._originalGrid.modes)
            grid.setGridModes(this._originalGrid.modes);
        grid.layout_manager.fixedIconSize = this._originalGrid.fixedIconSize;
        this._originalGrid = null;
        this._relayout();
    }

    _relayout() {
        Main.overview._overview?.controls?._appDisplay?._redisplay?.();
    }
}
