import 'neuroglancer/save_state/save_state.css';

import {debounce} from 'lodash';
import {Dialog} from 'neuroglancer/dialog';
import {Overlay} from 'neuroglancer/overlay';
import {dismissUnshareWarning, getSaveToAddressBar, getUnshareWarning} from 'neuroglancer/preferences/user_preferences';
import {StatusMessage} from 'neuroglancer/status';
import {br} from 'neuroglancer/util/br';
import {RefCounted} from 'neuroglancer/util/disposable';
import {getRandomHexString} from 'neuroglancer/util/random';
import {Trackable} from 'neuroglancer/util/trackable';
import {UrlType, Viewer} from 'neuroglancer/viewer';


const deprecatedKey = 'neuroglancerSaveState';
const stateKey = 'neuroglancerSaveState_v2';
const historyKey = 'neuroglancerSaveHistory';
// TODO: Remove state ID from URL and preserve updated state order, or use timestamp
// const orderKey = 'neuroglancerSaveOrder';

export class SaveState extends RefCounted {
  key?: string;
  session_id = getRandomHexString();
  savedUrl?: string;
  supported = true;
  constructor(public root: Trackable, public viewer: Viewer, updateDelayMilliseconds = 400) {
    super();
    const userDisabledSaver = getSaveToAddressBar().value;

    if (storageAccessible()) {
      this.loadFromKey();
      this.registerEventListener(window, 'popstate', () => this.loadFromKey());
    } else {
      this.supported = false;
      StatusMessage.messageWithAction(
          `Warning: Cannot access Local Storage. Unsaved changes will be lost! Use Legacy Saving to allow for auto saving.`,
          [{message: 'Ok'}], 30000, {color: 'red'});
    }
    if (userDisabledSaver) {
      this.supported = false;
      StatusMessage.showTemporaryMessage(
          `Save State has been disabled because Legacy Saving has been turned on in User Preferences.`,
          10000, {color: 'orange'});
    } else {
      const throttledUpdate = debounce(() => this.push(), updateDelayMilliseconds);
      this.registerDisposer(root.changed.add(throttledUpdate));
      this.registerDisposer(() => throttledUpdate.cancel());
      window.addEventListener('focus', (() => this.push()).bind(this));
    }
  }
  // Main Methods
  public pull() {
    // Get SaveEntry from localStorage
    if (storageAccessible() && this.key) {
      const entry = localStorage[`${stateKey}-${this.key}`];
      if (entry) {
        return JSON.parse(entry);
      }
    }
    return;
  }
  public push(clean?: boolean) {
    // update SaveEntry in localStorage
    if (storageAccessible() && this.key) {
      const source = <SaveEntry>this.pull() || {};
      if (source.history && source.history.length) {
        // history should never be empty
        if (this.reassign(source)) {
          source.history = [];
        }
        source.history = this.uniquePush(source.history, this.session_id);
      } else {
        source.history = [this.session_id];
      }
      const currentState = this.root.toJSON();
      const lastUpdatedState = source.state;
      const stateChange = this.viewer.differ!.record(currentState, lastUpdatedState);


      if (stateChange || clean) {
        source.state = currentState;
        // if clean is true, then this state is committed, and not dirty.
        source.dirty = clean ? !clean : true;
        const serializedUpdate = JSON.stringify(source);
        this.robustSet(`${stateKey}-${this.key}`, serializedUpdate);
      }
      this.setSaveStatus(source.dirty);
      this.notifyManager();
    }
  }
  public commit(source_url: string) {
    if (this.key) {
      this.savedUrl = source_url;
      this.addToHistory(recordHistory(source_url));
      this.push(true);
    }
  }
  private loadFromKey() {
    const params = new URLSearchParams(window.location.search);
    this.key = <any>params.get('local_id');

    if (this.key) {
      location.hash = '';
      let entry = this.pull();
      // TODO: REMOVE BACKWARD COMPATIBILITY
      if (!entry) {
        const oldDatabaseRaw = localStorage[deprecatedKey];
        const oldDatabase = JSON.parse(oldDatabaseRaw || '{}');
        entry = oldDatabase[this.key];
        delete oldDatabase[this.key];
        const serializedDatabase = JSON.stringify(oldDatabase);
        this.robustSet(deprecatedKey, serializedDatabase);
      }

      if (entry) {
        this.setSaveStatus(entry.dirty);
        try {
          this.root.restoreState(entry.state);
        } catch (e) {
          StatusMessage.showError(e);
        }
        StatusMessage.showTemporaryMessage(
            `Loaded from local storage. Do not duplicate this URL.`, 4000);
        if (entry.dirty && getUnshareWarning().value) {
          StatusMessage.messageWithAction(
              `This state has not been shared, share and copy the JSON or RAW URL to avoid losing progress. `,
              [
                {
                  message: 'Dismiss',
                  action: () => {
                    dismissUnshareWarning();
                    StatusMessage.showTemporaryMessage(
                        'To reenable this warning, check "Unshared state warning" in the User Preferences menu.',
                        5000);
                  }
                },
                {message: 'Share', action: () => this.viewer.postJsonState(true)}
              ],
              undefined, {color: 'yellow'});
        }
      } else {
        StatusMessage.showError(
            `This URL is invalid. Do not copy the URL in the address bar. Use the save button.`);
      }
    } else {
      this.setSaveStatus(true);
      this.generateKey();
    }
  }
  // Utility
  public purge() {
    if (storageAccessible()) {
      this.overwriteHistory();
    }
  }
  private nuke(complete = false) {
    if (storageAccessible()) {
      localStorage[stateKey] = '[]';
      const storage = localStorage;
      const storageKeys = Object.keys(storage);
      const stateKeys =
          complete ? storageKeys : storageKeys.filter(key => key.includes(`${stateKey}-`));
      stateKeys.forEach(target => localStorage.removeItem(target));
    }
  }
  public userRemoveEntries(complete = false) {
    this.nuke(complete);
    this.push();
  }
  private setSaveStatus(status = false) {
    const button = document.getElementById('neuroglancer-saver-button');
    if (button) {
      button.classList.toggle('dirty', status);
    }
    return status;
  }
  public history(): SaveHistory[] {
    const saveHistoryString = localStorage.getItem(historyKey);
    return saveHistoryString ? JSON.parse(saveHistoryString) : [];
  }
  private overwriteHistory(newHistory: SaveHistory[] = []) {
    this.robustSet(historyKey, JSON.stringify(newHistory));
  }
  public showSaveDialog(viewer: Viewer, jsonString?: string, get?: UrlType) {
    new SaveDialog(viewer, jsonString, get);
  }
  public showHistory(viewer: Viewer) {
    new SaveHistoryDialog(viewer, this);
  }
  // Helper
  private generateKey() {
    const whiteList = ['hide_news'];
    const oldParams = new URLSearchParams(window.location.search);
    const params = new URLSearchParams();
    // preserve some parameters
    for (var pair of oldParams.entries()) {
      if (whiteList.includes(pair[0])) {
        params.set(pair[0], pair[1]);
      }
    }

    this.key = getRandomHexString();
    params.set('local_id', this.key);
    history.pushState(
        {}, '', `${window.location.origin}${window.location.pathname}?${params.toString()}`);
  }
  private reassign(master: any) {
    const hist = <string[]>master.history;
    const lastIndex = hist.length - 1;
    const amILastEditor = hist[lastIndex] === this.session_id;
    if (!amILastEditor && hist.includes(this.session_id)) {
      // someone else is editing the state I am editing
      this.generateKey();
      return true;
    }
    return false;
  }
  private robustSet(key: string, data: any) {
    while (true) {
      try {
        localStorage.setItem(key, data);
        break;
      } catch (e) {
        // make space
        const entryCount = this.getManager().length;
        if (entryCount) {
          this.evict();
        } else {
          // if no space avaliable break and warn user
          throw e;
        }
      }
    }
  }
  /**
   * The manager is responsible for keeping track of unique save states
   */
  private getManager() {
    const managerRaw = localStorage[stateKey];
    return <string[]>JSON.parse(managerRaw || '[]');
  }
  /**
   * Registers a new state via ID into the manager
   */
  private notifyManager() {
    if (storageAccessible() && this.key) {
      const manager = this.uniquePush(this.getManager(), this.key);
      const serializedManager = JSON.stringify(manager);
      this.robustSet(stateKey, serializedManager);
    }
  }
  private evict(count = 1) {
    if (storageAccessible() && this.key) {
      const manager = this.getManager();

      const targets = manager.splice(0, count);
      const serializedManager = JSON.stringify(manager);
      localStorage.setItem(stateKey, serializedManager);
      targets.forEach(key => localStorage.removeItem(`${stateKey}-${key}`));
    }
  }
  private addToHistory(entry: SaveHistory) {
    const saveHistory = this.history();
    saveHistory.push(entry);
    if (saveHistory.length > 100) {
      saveHistory.splice(0, 1);
    }
    this.overwriteHistory(saveHistory);
  }
  private uniquePush(source: any[], entry: any) {
    const target = source.indexOf(entry);
    if (target > -1) {
      source.splice(target, 1);
    }
    source.push(entry);
    return source;
  }
}

/*form: HTMLElement, popupID?: string, content?:
string, textId?: string, disabled = false, fieldTitle = '', btnName?: string, btnTitle?: string,
btnAct?: EventListener, btnClass?: string, readonly = true, newLine = true */
type FieldConfig = {
  form: HTMLElement,
  popupID?: string,
  content?: string,
  textId?: string,
  disabled?: boolean,
  fieldTitle?: string,
  btnName?: string,
  btnTitle?: string,
  btnAct?: EventListener,
  btnClass?: string,
  readonly?: boolean,
  newLine?: boolean
};

class SaveDialog extends Overlay {
  constructor(public viewer: Viewer, jsonString?: string, getUrlType?: UrlType) {
    super();
    const jsonURLDefault = `LINK SHORTNER INACCESSIBLE`;

    const urlStart = `${window.location.origin}${window.location.pathname}`;
    const jsonUrl = jsonString ? `${urlStart}?json_url=${jsonString}` : jsonURLDefault;
    const rawUrl = `${urlStart}#!${viewer.hashBinding!.returnURLHash()}`;

    const existingShareDialog = document.getElementById('neuroglancer-save-state-json');
    if (existingShareDialog) {
      return;
    }

    if (getUrlType) {
      const copyString = getUrlType === UrlType.json ? jsonUrl : rawUrl;
      if (copyString !== jsonURLDefault) {
        const text = document.createElement('input');
        document.body.append(text);
        text.type = 'text';
        text.value = copyString;
        text.select();
        document.execCommand('copy');
        document.body.removeChild(text);
        StatusMessage.showTemporaryMessage(
            `Saved and Copied ${
                getUrlType === UrlType.json ? `JSON Link` : `Full State (RAW) link`} to Clipboard.`,
            5000);
      } else {
        StatusMessage.showTemporaryMessage(
            'Could not generate JSON link.', 2000, {color: 'yellow'});
      }
      this.dispose();
      return;
    }

    let formMain = document.createElement('form');
    let {content} = this;
    content.style.overflow = 'visible';
    content.classList.add('ng-dark');

    const title = document.createElement('h1');
    title.innerText = 'Share Link';
    const descr = document.createElement('div');
    descr.innerText = 'This link lets you share the exact view you currently see in neuroglancer.';
    descr.style.paddingBottom = '10px';
    descr.style.maxWidth = '360px';

    const viewSimple = document.createElement('div');
    {
      viewSimple.append(this.makePopup('JSON_URL'));
      this.insertField({
        form: viewSimple,
        popupID: `ng-save-popup-${'JSON_URL'}`,
        content: jsonUrl,
        textId: 'neuroglancer-save-state-json',
        disabled: jsonUrl === jsonURLDefault,
        fieldTitle:
            'This link points to a location where the state is saved with a server defined in "Advanced Options"',
        btnName: 'Copy',
        btnTitle: 'CTRL + SHIFT + J',
        btnClass: 'copy_button'
      });
    }

    const advanceTab = document.createElement('button');
    advanceTab.innerHTML = 'Advanced Options';
    advanceTab.type = 'button';
    advanceTab.classList.add('special-button');
    const viewAdvanc = document.createElement('div');
    advanceTab.addEventListener('click', () => {
      viewAdvanc.classList.toggle('ng-hidden');
    });
    {
      viewAdvanc.classList.toggle('ng-hidden', jsonUrl !== jsonURLDefault);
      viewAdvanc.append(this.makePopup('RAW_URL'));
      this.insertLabel(viewAdvanc, 'Long Link', 'neuroglancer-save-state-raw');

      this.insertField({
        form: viewAdvanc,
        popupID: `ng-save-popup-${'RAW_URL'}`,
        content: rawUrl,
        textId: 'neuroglancer-save-state-raw',
        fieldTitle:
            'This link contains the whole state, does not involve a server but might be too long to copy and share.',
        btnName: 'Copy',
        btnTitle: 'CTRL + SHIFT + R',
        btnClass: 'copy_button'
      });
      viewAdvanc.append(br());
      this.insertLabel(viewAdvanc, 'Link Shortener', 'neuroglancer-save-state-linkshare');
      this.insertField({
        form: viewAdvanc,
        popupID: '',
        content: viewer.jsonStateServer.value,
        textId: 'neuroglancer-save-state-linkshare',
        fieldTitle: '',
        readonly: false,
        btnName: 'Shorten',
        btnTitle: 'Push to state server to get JSON URL.',
        btnAct: () => {
          const field =
              <HTMLInputElement>document.getElementById('neuroglancer-save-state-linkshare');
          const fieldBtn = <HTMLButtonElement>document.getElementById(
              'neuroglancer-save-state-linkshare-button');
          viewer.jsonStateServer.value = field ? field.value : '';
          if (viewer.jsonStateServer.value && fieldBtn) {
            fieldBtn.disabled = true;
            saverToggle(false);
            const restoreSaving = () => {
              try {
                this.dispose();
              } catch {
              }
              saverToggle(true);
            };
            viewer.postJsonState(true, undefined, true, restoreSaving);
          }
        },
        btnClass: 'shorten_button'
      });

      /* TODO: This button may be renabled in the future
      const clearButton = document.createElement('button');
      {
        clearButton.innerText = '⚠️ Clear States';
        clearButton.title = 'Remove all Local States.';
        clearButton.type = 'button';
        clearButton.addEventListener('click', () => {
          if (confirm('All unshared or unopened states will be lost. Continue?')) {
            if (viewer.saver) {
              viewer.saver.userRemoveEntries();
            }
          }
        });
      }
      viewAdvanc.append(br());
      viewAdvanc.append(clearButton);
      */
    }

    formMain.append(title, descr, viewSimple, br(), advanceTab, viewAdvanc);

    let modal = document.createElement('div');
    content.appendChild(modal);

    modal.appendChild(formMain);

    modal.onblur = () => this.dispose();
    modal.focus();
  }

  private insertField(config: FieldConfig) {
    const {form} = config;
    let {content, textId, fieldTitle, disabled} = config;
    let {btnName, btnTitle, btnAct, btnClass} = config;
    let {readonly, newLine, popupID} = config;

    let text = document.createElement('input');
    text.readOnly = readonly === undefined ? true : readonly;
    text.type = 'text';
    text.value = content || '';
    text.size = 100;
    text.disabled = !!disabled;
    text.title = fieldTitle || '';
    text.classList.add('rounded-input');
    text.classList.toggle('disabled', !!disabled);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = btnClass || '';
    btn.classList.toggle('disabled', !!disabled);
    btn.disabled = !!disabled;
    if (btnAct && !disabled) {
      btn.addEventListener('click', btnAct);
    }
    btn.innerText = btnName || '';
    btn.title = btnTitle || '';

    if (textId) {
      text.id = textId;
      btn.id = `${text.id}-button`;
    }

    if (popupID) {
      const copyFtn = () => {
        text.select();
        document.execCommand('copy');
        let popup = document.getElementById(popupID!);
        if (popup) {
          popup.classList.add('ng-show');
        }
      };
      text.addEventListener('click', copyFtn);
      text.addEventListener('blur', () => {
        let popup = document.getElementById(popupID!);
        if (popup) {
          popup.classList.remove('ng-show');
        }
      });
      if (btnName && !btnAct) {
        btn.addEventListener('click', copyFtn);
      }
    }
    form.append(
        text, ' ', btn, (newLine || newLine === undefined) ? document.createElement('br') : '');
  }

  private insertLabel(form: HTMLElement, label: string, targetId: string, newLine = true) {
    let labelElement = document.createElement('label');
    labelElement.innerText = label;
    labelElement.htmlFor = targetId;
    form.append(labelElement, newLine ? document.createElement('br') : '');
  }

  private makePopup(label?: string) {
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
class SaveHistoryDialog extends Dialog {
  constructor(public viewer: Viewer, public saver: SaveState) {
    super(viewer);
    let {modal, table} = this;
    if (saver.supported) {
      let saves = saver.history();
      saves.reverse().forEach(this.addTableEntry.bind(this));

      if (!table.children.length) {
        modal.append(document.createElement('br'), `There are no saved states.`);
      }
    } else {
      this.dispose();
      StatusMessage.showTemporaryMessage(`Cannot access saved states.`, 10000);
    }
  }

  private addTableEntry(entry: SaveHistory) {
    if (!entry || !entry.source_url) {
      return;
    }
    const row = this.tableEntry();
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
  }

  public clearHandler() {
    this.saver.purge();
    this.dispose();
  }
}

interface SaveEntry {
  dirty: boolean;
  state: any;
  history: string[];
}

interface SaveHistory {
  source_url: string;
  timestamp: number;
}

const recordHistory = (url: string) => {
  return <SaveHistory>{timestamp: (new Date()).valueOf(), source_url: url};
};

export const saverToggle = (active: boolean) => {
  const saver = document.getElementsByClassName('ng-saver');
  let saveBtn: HTMLButtonElement;
  if (saver && saver.length) {
    saveBtn = <HTMLButtonElement>saver[0];
    saveBtn.classList.toggle('busy', !active);
    saveBtn.disabled = !active;
  }
};

export const storageAccessible = () => {
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
    const outOfSpace = e instanceof DOMException &&
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
    // outOfSpace is still accessible
    return outOfSpace;
  }
};
