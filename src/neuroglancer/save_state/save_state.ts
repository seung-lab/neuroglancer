import 'neuroglancer/save_state/save_state.css';

import {debounce} from 'lodash';
import {Overlay} from 'neuroglancer/overlay';
import {getOldStyleSaving} from 'neuroglancer/preferences/user_preferences';
import {StatusMessage} from 'neuroglancer/status';
import {RefCounted} from 'neuroglancer/util/disposable';
import {cancellableFetchOk, responseJson} from 'neuroglancer/util/http_request';
import {getRandomHexString} from 'neuroglancer/util/random';
import {Trackable} from 'neuroglancer/util/trackable';
import {UrlType, Viewer} from 'neuroglancer/viewer';
import {TrackableBoolean} from 'neuroglancer/trackable_boolean';

export class SaveState extends RefCounted {
  activeEntry?: SaveEntry;
  savedUrl?: string;
  private saveStorage: {[key: string]: SaveEntry;} = {};
  supported = true;
  constructor(public root: Trackable, updateDelayMilliseconds = 400) {
    super();
    const userDisabledSaver = getOldStyleSaving().value;

    if (storageAvailable()) {
      const saveStorageString = localStorage.getItem('neuroglancerSaveState');
      this.saveStorage = JSON.parse(saveStorageString || '{}');
      this.loadFromStorage();
      this.cull();
      this.registerEventListener(window, 'popstate', () => this.loadFromStorage());
    } else {
      this.supported = false;
      StatusMessage.showTemporaryMessage(
          `Warning: Cannot access Local Storage. Unsaved changes will be lost! Use OldStyleSaving to allow for auto saving.`,
          10000);
    }
    if (userDisabledSaver) {
      this.supported = false;
      StatusMessage.showTemporaryMessage(
          `Save State has been disabled because Old Style saving has been turned on in User Preferences.`,
          10000);
    } else {
      const throttledUpdate = debounce(() => this.updateStorage(), updateDelayMilliseconds);
      this.registerDisposer(root.changed.add(throttledUpdate));
      this.registerDisposer(() => throttledUpdate.cancel());
    }
  }

  purge() {
    if (storageAvailable()) {
      this.overwriteHistory();
    }
  }

  push() {
    if (storageAvailable()) {
      localStorage.setItem('neuroglancerSaveState', JSON.stringify(this.saveStorage));
    }
  }

  pull() {
    if (storageAvailable()) {
      this.saveStorage = {
        ...this.saveStorage,
        ...JSON.parse(localStorage.getItem('neuroglancerSaveState') || '{}')
      };
    }
  }

  cull(limit = 100) {
    if (storageAvailable()) {
      this.pull();
      if (this.list().length >= limit) {
        const recent = this.list().slice(0, limit);
        const newStorage: any = {};
        recent.forEach(entry => {
          newStorage[entry.state_id] = entry;
        });
        this.saveStorage = newStorage;
        this.push();
      }
      const history = this.history();
      this.overwriteHistory(history.slice(history.length - limit));
    }
  }

  list() {
    return (<SaveEntry[]>Object.values(this.saveStorage)).sort((a, b) => b.timestamp - a.timestamp);
  }

  history(): SaveHistory[] {
    const saveHistoryString = localStorage.getItem('neuroglancerSaveHistory');
    return saveHistoryString ? JSON.parse(saveHistoryString) : [];
  }

  addToHistory(entry: SaveHistory) {
    const saveHistoryString = this.history();
    saveHistoryString.push(entry);
    const record = JSON.stringify(saveHistoryString);
    localStorage.setItem('neuroglancerSaveHistory', record);
  }

  overwriteHistory(newHistory: SaveHistory[] = []) {
    localStorage.setItem('neuroglancerSaveHistory', JSON.stringify(newHistory));
  }

  unsaved() {
    const button = document.getElementById('neuroglancer-saver-button');
    if (this.activeEntry && button) {
      button.classList.toggle('dirty', this.activeEntry.dirty.value);
    }
  }

  loadFromStorage() {
    const params = new URLSearchParams(window.location.search);
    const givenKey = params.get('local_id');

    if (givenKey) {
      location.hash = '';
      const entry = this.saveStorage[givenKey];
      if (entry) {
          this.activeEntry = entry;
          if (entry.dirty === undefined || entry.dirty.value === undefined) {
            this.activeEntry.dirty = new TrackableBoolean(entry.dirty ? true : false);
            this.activeEntry.dirty.changed.add(this.unsaved.bind(this));
            this.unsaved();
          }
          this.root.restoreState(entry.state);
      } else {
        StatusMessage.showTemporaryMessage(
            `This URL is invalid. Do not copy the URL in the address bar. Use the save button.`,
            10000);
      }
    }
  }

  updateStorage() {
    let entry: SaveEntry;
    if (!this.activeEntry) {
      entry = recordEntry();
      entry.dirty.changed.add(this.unsaved.bind(this));
      this.activeEntry = entry;
      this.unsaved();
      const params = new URLSearchParams();
      params.set('local_id', this.activeEntry.state_id);
      this.saveStorage[this.activeEntry.state_id] = entry;
      history.pushState({}, '', `${window.location.origin}/?${params.toString()}`);
    } else {
      entry = this.activeEntry;
    }
    entry.state = this.root.toJSON();
    entry.dirty.value = true;
    this.saveStorage[entry.state_id] = entry;
    this.push();
  }

  commit(source_url: string) {
    if (this.activeEntry) {
      this.savedUrl = source_url;
      this.activeEntry.dirty.value = false;
      this.addToHistory(recordHistory(source_url));
    }
  }

  remoteLoad(json_url: string) {
    StatusMessage.forPromise(
        cancellableFetchOk(json_url, {}, responseJson).then(response => {
          this.root.restoreState(response);
        }),
        {
          initialMessage: `Retrieving state from json_url: ${json_url}.`,
          delay: true,
          errorPrefix: `Error retrieving state: `,
        });
  }

  showSaveDialog(viewer: Viewer, jsonString?: string, get?: UrlType) {
    new SaveDialog(viewer, jsonString, get);
  }

  showHistory(viewer: Viewer) {
    new SaveHistoryDialog(viewer, this);
  }
}

class SaveDialog extends Overlay {
  constructor(public viewer: Viewer, jsonString?: string, get?: UrlType) {
    super();

    let urlStart = `${window.location.origin}${window.location.pathname}`;
    let jsonUrl;
    if (jsonString) {
      jsonUrl = `${urlStart}?json_url=${jsonString}`;
    } else {
      if (!jsonUrl) {
        jsonUrl = 'NOT AVALABLE';
      }
    }
    const rawUrl = `${urlStart}#!${viewer.hashBinding!.returnURLHash()}`;

    if (get) {
      const copyString = get === UrlType.json ? jsonUrl : rawUrl;
      const text = document.createElement('input');
      document.body.append(text);
      text.type = 'text';
      text.value = copyString;
      text.select();
      document.execCommand('copy');
      document.body.removeChild(text);
      StatusMessage.showTemporaryMessage(`Saved and Copied ${get === UrlType.json ? `JSON Link` : `Full State (RAW) link`} to Clipboard.`, 5000);
      this.dispose();
      return;
    }

    let form = document.createElement('form');
    let {content} = this;
    content.style.overflow = 'visible';

    let modal = document.createElement('div');
    content.appendChild(modal);

    form.append(this.makePopup('JSON_URL'));
    this.insertField(
        form, 'JSON_URL', jsonUrl, 'neuroglancer-save-state-json', jsonUrl === 'NOT AVALABLE');
    form.append(document.createElement('br'));
    form.append(this.makePopup('RAW_URL'));
    this.insertField(form, 'RAW_URL', rawUrl, 'neuroglancer-save-state-raw');
    form.append('DEPRECATED');
    StatusMessage.showTemporaryMessage(`Saved.`, 5000);
    modal.appendChild(form);

    modal.onblur = () => this.dispose();
    modal.focus();
  }

  insertField(
      form: HTMLElement, label?: string, content?: string, textId?: string, disabled = false) {
    let labelElement = document.createElement('label');
    labelElement.innerText = label || '';
    let text = document.createElement('input');
    text.readOnly = true;
    text.type = 'text';
    text.value = content || '';
    text.size = 100;
    text.disabled = disabled;
    if (textId) {
      text.id = textId;
    }
    const id = `ng-save-popup-${label || ''}`;
    text.addEventListener('click', () => {
      text.select();
      document.execCommand('copy');
      let popup = document.getElementById(id);
      popup!.classList.add('ng-show');
    });
    text.addEventListener('blur', () => {
      let popup = document.getElementById(id);
      popup!.classList.remove('ng-show');
    });
    form.append(labelElement, ' ', text, document.createElement('br'));
  }

  makePopup(label?: string) {
    let popupContainer = document.createElement('div');
    popupContainer.classList.add('ng-popup');
    let popupContent = document.createElement('span');
    popupContent.classList.add('ng-popuptext');
    popupContent.innerText = 'Copied...';
    popupContent.id = `ng-save-popup-${label || ''}`;
    popupContainer.appendChild(popupContent);
    return popupContainer;
  }
}

class SaveHistoryDialog extends Overlay {
  table = document.createElement('table');
  constructor(public viewer: Viewer, saver: SaveState) {
    super();
    let {content, table} = this;
    if (saver.supported) {
      saver.pull();
      let saves = saver.history();
      let modal = document.createElement('div');
      content.appendChild(modal);

      table.classList.add('ng-zebra-table');
      saves.reverse().forEach(this.tableEntry.bind(this));

      const clear = document.createElement('button');
      clear.innerText = 'Clear';
      clear.title = 'Remove all saved states.';
      clear.addEventListener('click', () => {
        saver.purge();
        this.dispose();
      });

      modal.append(clear);
      if (!table.children.length) {
        modal.append(document.createElement('br'), `There are no saved states.`);
      }
      modal.append(table);
      modal.onblur = () => this.dispose();
      modal.focus();
    } else {
      this.dispose();
      StatusMessage.showTemporaryMessage(`Cannot access saved states.`, 10000);
    }
  }

  tableEntry(entry: SaveHistory) {
    if (!entry || !entry.source_url) {
      return;
    }
    const row = document.createElement('tr');
    const date = document.createElement('td');
    const link = document.createElement('td');
    const linkAnchor = document.createElement('a');

    date.innerText = (new Date(entry.timestamp)).toLocaleString();
    linkAnchor.innerText =
        `${window.location.origin}${window.location.pathname}?json_url=${entry.source_url}`;
    linkAnchor.href = linkAnchor.innerText;
    linkAnchor.style.display = 'block';
    link.append(linkAnchor);
    row.append(date, link);
    this.table.append(row);
  }
}

interface SaveEntry {
  timestamp: number;
  state_id: string;
  dirty: TrackableBoolean;
  state: any;
}

interface SaveHistory {
  source_url: string;
  timestamp: number;
}

const recordEntry = (state = {}) => {
  return <SaveEntry>{
    timestamp: (new Date()).valueOf(),
    state_id: getRandomHexString(),
    dirty: new TrackableBoolean(false, false),
    state
  };
};

const recordHistory = (url: string) => {
  return <SaveHistory>{
    timestamp: (new Date()).valueOf(),
    source_url: url
  };
};

export const storageAvailable = () => {
  // Stolen from
  // https://developer.mozilla.org/en-US/docs/Web/API/Web_Storage_API/Using_the_Web_Storage_API
  const type = 'localStorage';
  let storage;
  try {
    storage = window[type];
    let x = '__storage_test__';
    storage.setItem(x, x);
    storage.removeItem(x);
    return true;
  } catch (e) {
    return false;
  }
};
