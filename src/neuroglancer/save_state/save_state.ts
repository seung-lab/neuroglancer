import 'neuroglancer/save_state/save_state.css';

import {debounce} from 'lodash';

import {Overlay} from 'neuroglancer/overlay';
import {getOldStyleSaving} from 'neuroglancer/preferences/user_preferences';
import {StatusMessage} from 'neuroglancer/status';
import {RefCounted} from 'neuroglancer/util/disposable';
import {cancellableFetchOk, responseJson} from 'neuroglancer/util/http_request';
import {getRandomHexString} from 'neuroglancer/util/random';
import {Trackable} from 'neuroglancer/util/trackable';
import {Viewer} from 'neuroglancer/viewer';

export class SaveState extends RefCounted {
  private activeKey?: string|null;
  lastKey?: string|null;
  saveStorage: any;
  supported = true;
  constructor(public root: Trackable, updateDelayMilliseconds = 400) {
    super();
    // TODO: Smelly code
    if (storageAvailable()) {
      const saveStorageString = localStorage.getItem('neuroglancerSaveState');
      this.saveStorage = JSON.parse(saveStorageString || '{}');
      this.loadFromStorage();
      this.cull();

      this.registerEventListener(window, 'popstate', () => this.loadFromStorage());
    } else {
      this.supported = false;
      this.saveStorage = {};
      StatusMessage.showTemporaryMessage(
          `Warning: Cannot access Local Storage. Unsaved changes will be lost! Use OldStyleSaving to allow for auto saving.`,
          10000);
    }
    if (!getOldStyleSaving().value) {
      // this.registerEventListener(window, 'hashchange', () => this.updateFromUrlHash());
      const throttledUpdate = debounce(() => this.updateStorage(), updateDelayMilliseconds);
      this.registerDisposer(root.changed.add(throttledUpdate));
      this.registerDisposer(() => throttledUpdate.cancel());
    } else {
      this.supported = false;
      StatusMessage.showTemporaryMessage(
          `Save State has been disabled because Old Style saving has been turned on in User Preferences.`,
          10000);
    }
  }

  purge() {
    if (storageAvailable() && this.activeKey) {
      const current = this.saveStorage[this.activeKey];
      this.saveStorage = {[current.state_id]: current};
      this.push();
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
    }
  }

  list() {
    return (<SaveEntry[]>Object.values(this.saveStorage)).sort((a, b) => b.timestamp - a.timestamp);
  }

  loadFromStorage() {
    const params = new URLSearchParams(window.location.search);
    const givenKey = params.get('sid');

    if (givenKey) {
      location.hash = '';
      const entry = this.saveStorage[givenKey];
      this.activeKey = givenKey;
      this.lastKey = this.activeKey;
      if (entry) {
        if (entry.state) {
          this.root.restoreState(entry.state);
        } else {
          // older valid state
          this.remoteLoad(entry.source_url);
        }
      } else {
        StatusMessage.showTemporaryMessage(
            `This URL is invalid. Do not copy the URL in the address bar. Use the save button.`,
            10000);
      }
    }
  }

  updateStorage() {
    let entry;
    if (!this.activeKey) {
      entry = recordEntry();
      this.activeKey = entry.state_id;
      this.lastKey = this.activeKey;
      const params = new URLSearchParams();
      params.set('sid', this.activeKey);
      history.pushState({}, '', `${window.location.origin}/?${params.toString()}`);
    } else {
      entry = this.saveStorage[this.activeKey];
    }
    entry.state = this.root.toJSON();
    this.saveStorage[this.activeKey] = entry;
    this.push();
  }

  commit(source_url?: string) {
    if (this.activeKey) {
      if (source_url) {
        const entry = this.saveStorage[this.activeKey];
        entry.state = null;
        entry.source_url = source_url;
        this.activeKey = null;
      } else {
        this.saveStorage[this.activeKey] = null;
      }
      this.push();
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

  showSaveDialog(viewer: Viewer, jsonString?: string) {
    new SaveDialog(viewer, this, jsonString);
  }

  showHistory(viewer: Viewer) {
    new SaveStateDialog(viewer, this);
  }
}

class SaveDialog extends Overlay {
  constructor(public viewer: Viewer, saver: any, jsonString?: string) {
    super();
    let {content} = this;
    content.style.overflow = 'visible';

    let modal = document.createElement('div');
    content.appendChild(modal);

    let form = document.createElement('form');
    let urlStart = `${window.location.origin}${window.location.pathname}`;
    let jsonUrl;
    if (jsonString) {
      jsonUrl = `${urlStart}?json_url=${jsonString}`;
    } else {
      if (saver.supported) {
        let entry = saver.saveStorage[saver.lastKey];
        jsonUrl = `${urlStart}?json_url=${entry.source_url}`;
      }
      if (!jsonUrl) {
        jsonUrl = 'NOT AVALABLE';
      }
    }

    form.append(this.makePopup('JSON_URL'));
    this.insertField(form, 'JSON_URL', jsonUrl, jsonUrl === 'NOT AVALABLE');
    form.append(document.createElement('br'));
    form.append(this.makePopup('RAW_URL'));
    this.insertField(form, 'RAW_URL', `${urlStart}#!${viewer.hashBinding!.returnURLHash()}`);
    form.append('DEPRECATED');
    modal.appendChild(form);

    modal.onblur = () => this.dispose();
    modal.focus();
  }

  insertField(form: HTMLElement, label?: string, content?: string, disabled = false) {
    let labelElement = document.createElement('label');
    labelElement.innerText = label || '';
    let text = document.createElement('input');
    text.readOnly = true;
    text.type = 'text';
    text.value = content || '';
    text.size = 100;
    text.disabled = disabled;
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

class SaveStateDialog extends Overlay {
  table = document.createElement('table');
  constructor(public viewer: Viewer, saver: SaveState) {
    super();
    let {content, table} = this;
    if (saver.supported) {
      saver.pull();
      let saves = saver.list();
      let modal = document.createElement('div');
      content.appendChild(modal);

      table.classList.add('ng-zebra-table');
      saves.forEach(this.tableEntry);

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

  tableEntry(entry: SaveEntry) {
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
  source_url: string|null;
  state_id: string;
  state: any;
  timestamp: number;
}

const recordEntry = (state = {}) => {
  return <SaveEntry>{
    timestamp: (new Date()).valueOf(),
    state_id: getRandomHexString(),
    source_url: null,
    state
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
    return e instanceof DOMException &&
        (
               // everything except Firefox
               e.code === 22 ||
               // Firefox
               e.code === 1014 ||
               // test name field too, because code might not be present
               // everything except Firefox
               e.name === 'QuotaExceededError' ||
               // Firefox
               e.name === 'NS_ERROR_DOM_QUOTA_REACHED') &&
        // acknowledge QuotaExceededError only if there's something already stored
        (storage && storage.length !== 0);
  }
};
