import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {capture, jadeCommand} from './common.js';

const REPO = 'https://github.com/parvezrob/jade-shell';

// The About page: the version, credits, updates, a check of the whole setup
// (`jade doctor` as rows) and the way back to the desktop from before Jade
// Shell (`jade restore`), all without a terminal.
export function aboutPage(settings, metadata, switchRow) {
    const version = metadata['version-name'] ?? null;
    const page = new Adw.PreferencesPage({title: 'About', icon_name: 'help-about-symbolic'});

    const about = new Adw.PreferencesGroup();
    page.add(about);
    const info = new Adw.ActionRow({
        title: 'Jade Shell', subtitle: version ? `Version ${version}` : 'Development copy (from a checkout)',
        activatable: true,
    });
    info.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
    info.connect('activated', () => showAbout(info, version));
    about.add(info);

    const updates = new Adw.PreferencesGroup({title: 'Updates'});
    page.add(updates);
    switchRow(settings, updates, 'check-updates', 'Check for updates', 'Once a day; a notification when a new version is out');

    const checks = new Adw.PreferencesGroup({
        title: 'Check Jade Shell',
        description: 'Everything Jade Shell needs, and what to do about anything missing.',
    });
    page.add(checks);
    const runChecks = new Adw.ButtonRow({title: 'Run Checks', start_icon_name: 'emblem-default-symbolic'});
    checks.add(runChecks);
    let results = [];
    runChecks.connect('activated', async () => {
        runChecks.sensitive = false;
        results.forEach(row => checks.remove(row));
        results = await checkRows();
        results.forEach(row => checks.add(row));
        runChecks.title = 'Run Checks Again';
        runChecks.sensitive = true;
    });

    const restore = new Adw.PreferencesGroup({
        title: 'Restore',
        description: 'Put back the theme, dock, extensions and settings you had before Jade Shell, and turn Jade Shell off. ' +
            'Edits you made to your app configs since stay.',
    });
    page.add(restore);
    const restoreRow = new Adw.ButtonRow({title: 'Restore My Previous Desktop…'});
    restoreRow.add_css_class('destructive-action');  // added: css_classes would drop the row's own
    restoreRow.connect('activated', () => confirmRestore(restoreRow));
    restore.add(restoreRow);
    return page;
}

function showAbout(parent, version) {
    const dialog = new Adw.AboutDialog({
        application_name: 'Jade Shell',
        application_icon: 'preferences-desktop-appearance',
        developer_name: 'parvezrob',
        version: version ?? 'development copy',
        comments: 'Omarchy’s look for the GNOME you already have.',
        website: REPO,
        issue_url: `${REPO}/issues`,
        license_type: Gtk.License.GPL_3_0,
        copyright: 'Not affiliated with Omarchy, Basecamp or GNOME.',
    });
    dialog.add_credit_section('Inspired by', ['Omarchy by DHH and the Omarchy contributors https://omarchy.org']);
    dialog.add_acknowledgement_section('Built on', [
        'Omarchy’s themes, templates and usage collectors (MIT) https://github.com/basecamp/omarchy',
        'GNOME Shell’s theme sources (GPL-2.0-or-later) https://gitlab.gnome.org/GNOME/gnome-shell',
        'Ideas and code from Simple Workspaces Bar, Panel Date Format, Just Perfection, App Grid Tuner, TopHat and Vitals',
        'The layout of Omarchy Notification Center (an idea, no code)',
    ]);
    dialog.present(parent.get_root());
}

async function checkRows() {
    const jade = jadeCommand();
    let report = null;
    if (jade) {
        try {
            report = JSON.parse((await capture([jade, 'doctor', '--json'])).stdout);
        } catch {}
    }
    if (!report) {
        return [new Adw.ActionRow({
            title: 'Could not run the checks', subtitle: 'The jade command is missing: reinstall Jade Shell.',
        })];
    }
    const rows = report.rows.map(item => {
        const row = new Adw.ActionRow({
            title: item.text, subtitle: item.fix ?? '', subtitle_selectable: Boolean(item.fix), title_lines: 2,
        });
        // Checks: a green tick or a warning. Notes (the apps, the collector),
        // as in the terminal: a quiet tick when in use, a dash when not.
        const note = item.ok === null;
        const icon = note ? item.active === false ? 'list-remove-symbolic' : 'object-select-symbolic'
            : item.ok ? 'emblem-ok-symbolic' : 'dialog-warning-symbolic';
        const image = new Gtk.Image({icon_name: icon, valign: Gtk.Align.CENTER});
        image.add_css_class(note ? 'dim-label' : item.ok ? 'success' : 'warning');
        row.add_prefix(image);
        if (note && item.active === false)
            row.add_css_class('dim-label');
        return row;
    });
    const summary = new Adw.ActionRow({
        title: report.problems ? `${report.problems} problem${report.problems === 1 ? '' : 's'} found` : 'All good',
    });
    summary.add_css_class('heading');
    return [summary, ...rows];
}

function confirmRestore(row) {
    const dialog = new Adw.AlertDialog({
        heading: 'Restore Your Previous Desktop?',
        body: 'Jade Shell puts back what it changed and turns itself off; log out and back in afterwards to finish. ' +
            'It stays installed until you remove its package.',
    });
    dialog.add_response('cancel', 'Cancel');
    dialog.add_response('restore', 'Restore');
    dialog.set_response_appearance('restore', Adw.ResponseAppearance.DESTRUCTIVE);
    dialog.set_default_response('cancel');
    dialog.connect('response', async (_d, response) => {
        if (response !== 'restore')
            return;
        row.sensitive = false;
        row.title = 'Restoring…';
        const jade = jadeCommand();
        const result = jade ? await capture([jade, 'restore', '--yes']) : {ok: false, stdout: '', stderr: 'jade is missing'};
        row.title = 'Restore My Previous Desktop…';
        row.sensitive = true;
        showRestoreResult(row, result);
    });
    dialog.present(row.get_root());
}

function showRestoreResult(row, {ok, stdout, stderr}) {
    const lines = `${stdout}${stderr}`.trim().split('\n').filter(line => !line.startsWith('Restored the desktop'));
    const dialog = new Adw.AlertDialog({
        heading: ok ? 'Your Previous Desktop Is Back' : 'Could Not Restore',
        body: ok ? ['Log out and back in to finish.', ...lines].join('\n\n')
            : `${lines.join('\n') || 'Something went wrong.'}\n\nTry "jade restore" in a terminal to see more.`,
    });
    dialog.add_response('close', 'Close');
    if (ok) {
        dialog.add_response('logout', 'Log Out…');
        dialog.set_response_appearance('logout', Adw.ResponseAppearance.SUGGESTED);
        dialog.set_default_response('logout');
    }
    dialog.connect('response', (_d, response) => {
        if (response === 'logout')
            capture(['gnome-session-quit', '--logout']);  // GNOME's own dialog asks to confirm
    });
    dialog.present(row.get_root());
}
