import {debounce} from 'lodash';

import {RefCounted} from '../util/disposable';
import {getRandomHexString} from '../util/random';
import {Trackable} from '../util/trackable';
// TODO: LOAD JSON FROM URL IN THE SAME PLACE WE DO SID LOADING
export class SaveState extends RefCounted {
  private activeKey?: string|null;
  history: SaveEntry[];
  saveStorage: any;
  constructor(public root: Trackable, updateDelayMilliseconds = 400) {
    super();
    // TODO: BACKWARDS COMPATIBILITY FOR NO STORAGE
    if (storageAvailable()) {
      const saveStorageString = localStorage.getItem('neuroglancerSaveState');
      this.saveStorage = JSON.parse(saveStorageString || '{}');
      this.loadFromStorage();

      // this.registerEventListener(window, 'hashchange', () => this.updateFromUrlHash());
      const throttledUpdate = debounce(() => this.updateStorage(), updateDelayMilliseconds);
      this.registerDisposer(root.changed.add(throttledUpdate));
      this.registerDisposer(() => throttledUpdate.cancel());
    }
  }

  commit() {
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
        }
      } else {
        // Invalid state key
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
      history.replaceState({}, '', `${window.location.origin}/?${params.toString()}`);
    } else {
      entry = this.saveStorage[this.activeKey];
    }
    entry.state = this.root.toJSON();
    this.saveStorage[this.activeKey] = entry;
    this.commit();
  }

  reset() {
    if (this.activeKey) {
      const entry = this.saveStorage[this.activeKey];
      entry.state = null;
      entry.source_url = window.location.href;
      this.activeKey = null;
      this.commit();
    }
  }
}

export class SaveStateDialog {}

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
