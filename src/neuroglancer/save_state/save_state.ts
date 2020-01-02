import {debounce} from 'lodash';

import {RefCounted} from '../util/disposable';
import {getRandomHexString} from '../util/random';
import {Trackable} from '../util/trackable';
import { Viewer } from '../viewer';
import { Overlay } from '../overlay';
// TODO: LOAD JSON FROM URL IN THE SAME PLACE WE DO SID LOADING
export class SaveState extends RefCounted {
  private activeKey?: string|null;
  history: SaveEntry[];
  saveStorage: any;
  supported = true;
  constructor(public root: Trackable, public loadJSON: Function, updateDelayMilliseconds = 400) {
    super();
    if (storageAvailable()) {
      const saveStorageString = localStorage.getItem('neuroglancerSaveState');
      this.saveStorage = JSON.parse(saveStorageString || '{}');
      this.loadFromStorage();

      // this.registerEventListener(window, 'hashchange', () => this.updateFromUrlHash());
      const throttledUpdate = debounce(() => this.updateStorage(), updateDelayMilliseconds);
      this.registerDisposer(root.changed.add(throttledUpdate));
      this.registerDisposer(() => throttledUpdate.cancel());
    } else {
      this.supported = false;
    }
  }

  push() {
    localStorage.setItem('neuroglancerSaveState', JSON.stringify(this.saveStorage));
  }

  loadFromStorage() {
    const params = new URLSearchParams(window.location.search);
    const givenKey = params.get('sid');

    if (givenKey) {
      const entry = this.saveStorage[givenKey];
      this.activeKey = givenKey;
      if (entry) {
        if (entry.state) {
          this.root.restoreState(entry.state);
        } else {
          // older valid state
          // TODO: Load from JSON URL
          this.loadJSON(entry.source_url);
        }
      } else {
        // Invalid state key
        // TODO: ERROR MESSAGE
      }
    }
  }

  updateStorage() {
    let entry;
    if (!this.activeKey) {
      // TODO: May want this to only be JSON URL
      entry = recordEntry(window.location.href);
      this.activeKey = entry.state_id;
      const params = new URLSearchParams();
      params.set('sid', this.activeKey);
      // Push instead of replace to preserve history could use entry.timestamp
      history.pushState({}, (new Date()).toISOString(), `${window.location.origin}/?${params.toString()}`);
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
}

export class SaveDialog {
  constructor(public viewer: Viewer) {}
}

export class SaveStateDialog extends Overlay {
  constructor(public viewer: Viewer) {
    super();
  }
}
interface SaveEntry {
  source_url: string;
  state_id: string;
  state: any;
  timestamp: number;
}

const recordEntry = (source_url: string, state = {}) => {
  return {timestamp: (new Date()).valueOf(), state_id: getRandomHexString(), source_url, state};
};

const storageAvailable = () => {
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
