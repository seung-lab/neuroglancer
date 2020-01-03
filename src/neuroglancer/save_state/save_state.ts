import {debounce} from 'lodash';

import {Overlay} from '../overlay';
import {StatusMessage} from '../status';
import {RefCounted} from '../util/disposable';
import {cancellableFetchOk, responseJson} from '../util/http_request';
import {getRandomHexString} from '../util/random';
import {Trackable} from '../util/trackable';
import {Viewer} from '../viewer';

import 'neuroglancer/save_state/save_state.css';

// TODO: LOAD JSON FROM URL IN THE SAME PLACE WE DO SID LOADING
export class SaveState extends RefCounted {
  private activeKey?: string|null;
  history: SaveEntry[];
  saveStorage: any;
  supported = true;
  constructor(public root: Trackable, updateDelayMilliseconds = 400) {
    super();
    if (storageAvailable()) {
      const saveStorageString = localStorage.getItem('neuroglancerSaveState');
      this.saveStorage = JSON.parse(saveStorageString || '{}');
      this.loadFromStorage();

      this.registerEventListener(window, 'popstate', () => this.loadFromStorage());
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
          this.remoteLoad(entry.source_url);
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
      history.pushState(
          {}, (new Date()).toISOString(), `${window.location.origin}/?${params.toString()}`);
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

  showSaveDialog(viewer: Viewer) {
    new SaveDialog(viewer, this);
  }
}

class SaveDialog extends Overlay {
  constructor(public viewer: Viewer, saver: any) {
    super();
    let {content} = this;

    let modal = document.createElement('div');
    content.appendChild(modal);

    let entry = saver.saveStorage[saver.activeKey];
    let form = document.createElement('form');
    let urlStart = window.location.origin + window.location.pathname;
    let popupContainer = document.createElement('div');
    popupContainer.classList.add('ng-popup');
    let popupContent = document.createElement('span');
    popupContent.classList.add('ng-popuptext');
    popupContent.innerText = 'Copied...';
    popupContent.id = 'ng-save-popup';
    popupContainer.appendChild(popupContent);
    modal.appendChild(popupContainer);

    this.insertField(form, 'JSON_URL', `${urlStart}?json_url='${entry.source_url}`);
    form.append(document.createElement('br'));
    this.insertField(form, 'RAW_URL', `${urlStart}#!'${viewer.hashBinding!.returnURLHash()}`);
    form.append('DEPRECATED');
    modal.appendChild(form);

    modal.onblur = () => this.dispose();
    modal.focus();
  }

  insertField(form: HTMLElement, label?: string, content?: string) {
    let labelElement = document.createElement('label');
    labelElement.innerText = label || '';
    let text = document.createElement('input');
    text.readOnly = true;
    text.type = 'text';
    text.value = content || '';
    text.size = 100;
    text.addEventListener('click', () => {
      text.select();
      document.execCommand('copy');
      let popup = document.getElementById('ng-save-popup');
      popup!.classList.toggle('ng-show');
    });
    form.append(labelElement, ' ', text, document.createElement('br'));
  }
}


export class SaveStateDialog extends Overlay {
  constructor(public viewer: Viewer) {
    super();
  }
}
/*export class WhatsNewDialog extends Overlay {
  constructor(public viewer: Viewer, description: string = '') {
    super();
    let {content} = this;

    if (!description.length) {
      description = generateWhatsNew();
    }

    let modal = document.createElement('div');

    content.appendChild(modal);

    let header = document.createElement('h3');
    header.textContent = `What's New`;
    modal.appendChild(header);

    let body = document.createElement('p');
    body.innerHTML = description;
    modal.appendChild(body);

    let okBtn = document.createElement('button');
    okBtn.textContent = 'Ok';
    okBtn.onclick = () => this.dispose();

    modal.appendChild(okBtn);
    modal.onblur = () => this.dispose();
    modal.focus();
  }
}*/

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
