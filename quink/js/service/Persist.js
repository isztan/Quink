/**
 * Quink, Copyright (c) 2013-2014 IMD - International Institute for Management Development, Switzerland.
 *
 * This file is part of Quink.
 * 
 * Quink is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Quink is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with Quink.  If not, see <http://www.gnu.org/licenses/>.
 */

define([
    'jquery',
    'util/Env',
    'util/PubSub',
    'util/DomUtil',
    'util/ChangeMonitor'
], function ($, Env, PubSub, DomUtil, ChangeMonitor) {
    'use strict';

    var Persist = function () {
        this.init();
    };

    /**
     * In seconds.
     */
    Persist.prototype.AUTOSAVE_INTERVAL = '15';

    /**
     * Number of autosave errors before autosave is switched off.
     */
    Persist.prototype.AUTOSAVE_MAX_ERRORS = 3;

    /**
     * Auto save and persistence through submit both need the original page source, so download
     * it up front.
     */
    Persist.prototype.init = function () {
        var url = window.location.href,
            me = this;
        $.get(url, function (data) {
            PubSub.publish('persist.init.pagesrc', data);
            me.initPersistMonitors();
            me.initAutoSave();
        });
        this.boundChangeMonitorCallback = this.changeMonitorCallback.bind(this);
    };

    Persist.prototype.initPersistMonitors = function () {
        this.startChangeMonitor();
        PubSub.subscribe('error.persist', this.onPersistError.bind(this));
        PubSub.subscribe('command.executed', this.onExecCmd.bind(this));
    };

    /**
     * Returns true if the dom mutation being processed changes the main document rather than
     * affecting a part of the Quink implementation.
     */
    Persist.prototype.mutationChangesDoc = function (mutation) {
        var changesDoc = false;
        if (mutation.type === 'childList' || mutation.type === 'subtree') {
            changesDoc = DomUtil.nlSome(mutation.addedNodes, DomUtil.isWithinDocument) ||
                DomUtil.nlSome(mutation.removedNodes, DomUtil.isWithinDocument);
        } else {
            changesDoc = DomUtil.isWithinDocument(mutation.target);
        }
        return changesDoc;
    };

    /**
     * The change monitor will not provide any mutation records if the underlying implementation
     * isn't a dom mutation observer.
     */
    Persist.prototype.changeMonitorCallback = function (mutationRecords) {
        var hadChanges = this.hasDocChanges;
        this.hasDocChanges = this.hasDocChanges ||
            !mutationRecords ||
            mutationRecords.some(this.mutationChangesDoc);
        // Clear the mutation record queue after processing.
        this.changeMonitor.takeRecords();
        if (this.hasDocChanges !== hadChanges) {
            PubSub.publish('document.state', this.hasDocChanges);
        }
    };

    Persist.prototype.startChangeMonitor = function () {
        var opts = {
                'childList': true,
                'subtree': true,
                'attributes': true,
                'characterData': true
            };
        this.hasDocChanges = false;
        this.changeMonitor = this.changeMonitor || new ChangeMonitor(this.boundChangeMonitorCallback);
        this.changeMonitor.observe(document.body, opts);
    };

    Persist.prototype.stopChangeMonitor = function () {
        this.changeMonitor.disconnect();
    };

    /**
     * Pick up both unload events. If the before one fires it's best as a page reload will show
     * a changed page using the before event, but will show the old state using the unload
     * event. The save has been done in both cases, so a second reload will produce the expected
     * page state if the first one doesn't. This on desktop Chrome.
     */
    Persist.prototype.initUnloadListeners = function () {
        var save = function () {
                if (!this.saved && this.hasDocChanges) {
                    PubSub.publish('command.exec', 'persist.unloadsave');
                    this.saved = true;
                    this.hasDocChanges = false;
                }
            }.bind(this);
        $(window).on('beforeunload', save).on('unload', save);
    };

    /**
     * Stop auto save while a plugin is being used. This is to avoid the situation where plugin
     * artifacts (such as the iframe) are auto saved while the plugin is running, then the page
     * is unloaded. Also suspend the change monitor to avoid DOM changes made by the plugin
     * from affecting the document's dirty state.
     * When the plugin is closed restart auto save and the change monitoring. If the close was a
     * save then explicitly save the document. Can't rely on the change monitor as that was switched
     * off while the plugin was active and is switched on using the same publication as is used
     * to insert the plugin content into the document so we can't rely on it being operational
     * when the insert is done.
     */
    Persist.prototype.initPluginListeners = function () {
        PubSub.subscribe('plugin.open', function () {
            this.stopChangeMonitor();
            this.stopAutoSave();
        }.bind(this));
        PubSub.subscribe('plugin.saved', function () {
            PubSub.publish('command.exec', 'persist.autosave');
            this.startChangeMonitor();
        }.bind(this));
        PubSub.subscribe('plugin.exited', function () {
            this.startChangeMonitor();
            this.autoSave();
        }.bind(this));
    };

    Persist.prototype.initAutoSave = function () {
        var asi = parseInt(Env.getParam('autosaveinterval', this.AUTOSAVE_INTERVAL), 10);
        if (asi > 0) {
            this.initUnloadListeners();
            this.initPluginListeners();
            this.autoSaveInterval = asi * 1000;
            this.startAutoSave();
        } else {
            console.log('Autosave switched off via autosaveinterval query parameter.');
        }
    };

    /**
     * Stop auto save and optionally publish to this effect. Only publish if auto save has been
     * stopped in a permanent way due to errors, not if it's being stopped temporarily while a
     * plugin is in use.
     */
    Persist.prototype.stopAutoSave = function (andPublish) {
        clearTimeout(this.autoSaveTimeout);
        this.autoSaveTimeout = null;
        console.log('Autosave switched off.');
        if (andPublish) {
            PubSub.publish('persist.autosave', 'off');
        }
    };

    Persist.prototype.autoSave = function () {
        this.autoSaveTimeout = setTimeout(function () {
            if (this.hasDocChanges) {
                PubSub.publish('command.exec', 'persist.autosave');
            } else {
                this.autoSave();
            }
        }.bind(this), this.autoSaveInterval);
    };

    /**
     * Determines whether auto save been switch off because of errors.
     */
    Persist.prototype.isAutoSaveOffOnError = function () {
        return this.autoSaveInterval > 0 && !this.autoSaveTimeout;
    };

    /**
     * Restart auto save when its been previously switched off due to too many errors.
     */
    Persist.prototype.startAutoSave = function (andPublish) {
        this.autoSaveErrors = 0;
        this.autoSave();
        if (andPublish) {
            PubSub.publish('persist.autosave', 'on');
        }
    };

    /**
     * Restart auto save if this is a successful auto save or if it's a successful user initiated
     * save when auto save has been previously switched off.
     */
    Persist.prototype.onExecCmd = function (msg) {
        var args = (typeof msg === 'string') && msg.split('.');
        if (args && args[0] === 'persist') {
            this.hasDocChanges = false;
            if (args[1] === 'autosave') {
                this.startAutoSave();
            } else if (args[1] === 'save' && this.isAutoSaveOffOnError()) {
                this.startAutoSave(true);
            }
        }
    };

    /**
     * Switch off auto save if there have been too many errors. Switch on auto save if an
     * explicit user initiated save has failed.
     */
    Persist.prototype.onPersistError = function (data) {
        if (data.operation === 'autosave') {
            this.autoSaveErrors += 1;
            if (this.autoSaveErrors < this.AUTOSAVE_MAX_ERRORS) {
                this.autoSave();
            } else {
                this.stopAutoSave(true);
            }
        } else if (data.operation === 'save' && this.isAutoSaveOffOnError()) {
            this.startAutoSave(true);
        }
    };

    var theInstance;

    function create() {
        if (!theInstance) {
            theInstance = new Persist();
        }
        return theInstance;
    }

    return {
        create: create
    };
});
