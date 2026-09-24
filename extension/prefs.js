import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {Pages} from './settings/pages.js';

// GNOME's Extensions app shows the same pages as the Jade Shell app.
export default class JadePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        new Pages({settings: this.getSettings(), metadata: this.metadata, dir: this.dir}).fill(window);
    }
}
