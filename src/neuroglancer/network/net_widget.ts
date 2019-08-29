import {Overlay} from 'neuroglancer/overlay';
import {getAutoConnect} from 'neuroglancer/preferences/user_preferences';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';
import {Viewer} from 'neuroglancer/viewer';
import {makeTextIconButton} from 'neuroglancer/widget/text_icon_button';
// import {removeParameterFromUrl} from '../ui/url_hash_binding';

require('./net_widget.css');

interface User {
  id: number;
  chan: any;
  name?: string;
}

interface InputConfig {
  id: string;
  classes?: string[];
  value?: string;
  disabled?: boolean;
  type?: string;
  checked?: boolean;
}

interface NetworkPrefs {
  host: string;
  user: User;
  syncables: any;
  syncChan: string;
}

const br = () => document.createElement('br');
const brp = (e: HTMLElement) => [e, br(), br()];
abstract class NetworkOverlay extends Overlay {
  constructor(public viewer: Viewer, public net: Network) {
    super();
  }

  labelWrap =
      (label: string, element?: (HTMLElement|string)[], config?: InputConfig) => {
        const labelElement = document.createElement('label');
        labelElement.textContent = label;
        if (config) {
          const {id, classes} = config;
          labelElement.id = id;
          labelElement.classList.add(...(classes || []));
        }
        if (element) {
          labelElement.append(...element);
        }
        return labelElement;
      }

  simpleInput =
      (config: InputConfig) => {
        const {id, classes, value, disabled, type} = config;
        const textbox = document.createElement('input');

        textbox.id = id;
        textbox.type = type || 'text';
        textbox.value = value || '';
        textbox.disabled = disabled || false;
        textbox.classList.add(...(classes || []));
        return textbox;
      }

  simpleItem = (config: InputConfig = {id: '', type: 'checkbox'}) => {
    const {id, classes, value, disabled, type, checked} = config;
    const chkbox = document.createElement('input');

    chkbox.id = id;
    chkbox.type = type || 'text';
    chkbox.value = value || '';
    chkbox.disabled = disabled || false;
    chkbox.classList.add(...(classes || []));
    chkbox.checked = checked || false;
    if (type === 'radio') {
      chkbox.name = (classes || [])[0] || id || '';
    }
    return chkbox;
  }
}
class NetworkConfiguration extends NetworkOverlay {
  constructor(public viewer: Viewer, public net: Network) {
    super(viewer, net);
    const {labelWrap, simpleInput, /*simpleItem,*/ content} = this;
    const modal = document.createElement('div');
    content.appendChild(modal);

    let header = document.createElement('h3');
    header.textContent = 'Network Configuration';
    const uidField = labelWrap('ID', [
      ' ', simpleInput({id: 'net-uid', value: net.settings.user.id.toString(), disabled: true})
    ]);
    const connectBtn = document.createElement('button');
    connectBtn.id = 'net-connect-button';
    connectBtn.innerHTML = 'Connect';
    connectBtn.addEventListener('click', () => {
      const host = <HTMLInputElement>document.getElementById('net-hostaddr');
      net.settings.host = host.value;
      net.connect();
    });
    const hostField = labelWrap(
        'Host',
        [' ', simpleInput({id: 'net-hostaddr', value: net.settings.host}), ' ', connectBtn]);
    const applyBtn = document.createElement('button');
    applyBtn.innerHTML = 'Apply Changes';
    applyBtn.addEventListener('click', () => this.apply());
    const nickField = labelWrap(
        'Nickname', [' ', simpleInput({id: 'net-nick', value: net.settings.user.name || ''})]);

    let chanArr = <(string | HTMLElement)[]>[br()];
    let iter = 0;
    for (let cid in net.settings.user.chan) {
      let chanFields = this.addChan(iter);
      if (!iter) {
        chanFields = [chanFields[0]];
        (<HTMLInputElement>chanFields[0]).disabled = true;
      }
      (<HTMLInputElement>chanFields[0]).value = cid;
      (<HTMLInputElement>chanFields[0]).dataset['prev'] = cid;
      chanArr = [...chanArr, ...chanFields, br()];
    }
    const chanGroup = labelWrap('Channels', chanArr, {id: 'net-channels-group'});
    const newChannel = document.createElement('button');
    newChannel.id = 'net-addchannel-button';
    newChannel.innerHTML = '+';
    newChannel.addEventListener('click', () => {
      const channels = <HTMLInputElement[]>Array.from(document.querySelectorAll('.net-cid'));
      const it = channels.length;
      const chanFields = this.addChan(it);
      chanGroup.append(...chanFields, br());
    });
    const syncField = labelWrap('Sync Settings', []);

    const buildArr = [
      header, ...brp(uidField), ...brp(hostField), ...brp(applyBtn), ...brp(nickField), chanGroup,
      ...brp(newChannel), ...brp(syncField)
    ];
    modal.append(...buildArr);
  }

  apply() {
    const nick = (<HTMLInputElement>document.getElementById('net-nick')!).value;
    if (nick !== '' && nick !== this.net.settings.user.name) {
      this.net.settings.user.name = nick;
      this.net.nickname();
    }

    const channels = <HTMLInputElement[]>Array.from(document.querySelectorAll('.net-cid'));
    for (let field of channels) {
      const val = field.value;
      if (val !== '' && !this.net.settings.user.chan[val]) {
        field.dataset['prev'] = field.value;
        this.net.settings.user.chan[val] = 1;
        this.net.channel(val, true);
      }
    }
  }

  remChannelBtnBuilder =
      (id: string) => {
        const remove = document.createElement('button');
        remove.innerHTML = '-';
        remove.classList.add('net-remchannel-button');
        remove.addEventListener('click', () => {
          const target = <HTMLInputElement>document.getElementById(id);
          const key = target.dataset['prev']!;
          if (key) {
            this.net.channel(key, false);
            delete this.net.settings.user.chan[key];
          }
        });
        return remove;
      }

  addChan = (index: number) => {
    const textbox = document.createElement('input');
    textbox.classList.add('net-cid');
    textbox.id = `cid-idx-${index.toString()}`;
    textbox.type = 'text';
    return [textbox, ' ', this.remChannelBtnBuilder(textbox.id)];
  }
}

class NetworkHelp extends NetworkOverlay {
  constructor(public viewer: Viewer, public net: Network) {
    super(viewer, net);
    // let {content} = this;
  }
}

class NetworkSearch extends NetworkOverlay {
  constructor(public viewer: Viewer, public net: Network) {
    super(viewer, net);
    // let {content} = this;
  }
}

class NetworkChatWidget extends RefCounted {
  element = document.createElement('div');
  header = document.createElement('div');
  input = <HTMLInputElement>document.createElement('input');
  viewport = <HTMLTextAreaElement>document.createElement('textarea');
  activeCh = <HTMLSelectElement>document.createElement('select');

  constructor(net: Network) {
    super();

    const {element, header, input, viewport, activeCh} = this;
    element.className = 'neuroglancer-net-chatWindow';
    header.className = 'neuroglancer-net-chatHeader';
    viewport.className = 'neuroglancer-net-display';
    viewport.disabled = true;
    viewport.rows = 5;
    viewport.cols = 40;
    input.className = 'neuroglancer-net-input';
    input.type = 'text';
    const defopt = document.createElement('option');
    defopt.value = '0';
    defopt.innerHTML = '0(All)';
    activeCh.appendChild(defopt);
    activeCh.className = '.neuroglancer-net-channel';

    const config = makeTextIconButton('⚙', 'Net Config');
    const help = makeTextIconButton('?', 'Net Help');
    const search = makeTextIconButton('🔍', 'Net Query');
    const notify = makeTextIconButton('🔔', 'Notifications');
    const empty = makeTextIconButton('');
    empty.classList.add('empty-button');
    this.registerEventListener(config, 'click', () => {
      net.config();
    });
    this.registerEventListener(help, 'click', () => {
      net.nethelp();
    });
    this.registerEventListener(search, 'click', () => {
      net.searchDialog();
    });
    this.registerEventListener(notify, 'click', () => {
      net.notifyToggle();
    });
    header.appendChild(config);
    header.appendChild(search);
    header.appendChild(help);
    header.appendChild(notify);
    header.appendChild(empty);
    element.appendChild(header);
    element.appendChild(viewport);
    element.appendChild(document.createElement('br'));
    element.appendChild(activeCh);
    element.appendChild(input);

    this.dragElement();
  }

  dragElement() {
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    const elmnt = this.element;
    this.header.onmousedown = dragMouseDown;

    function dragMouseDown(e: MouseEvent) {
      e = e || window.event;
      e.preventDefault();
      // get the mouse cursor position at startup:
      pos3 = e.clientX;
      pos4 = e.clientY;
      document.onmouseup = closeDragElement;
      // call a function whenever the cursor moves:
      document.onmousemove = elementDrag;
    }

    function elementDrag(e: MouseEvent) {
      e = e || window.event;
      e.preventDefault();
      // calculate the new cursor position:
      pos1 = pos3 - e.clientX;
      pos2 = pos4 - e.clientY;
      pos3 = e.clientX;
      pos4 = e.clientY;
      // set the element's new position:
      elmnt.style.top = (elmnt.offsetTop - pos2) + 'px';
      elmnt.style.left = (elmnt.offsetLeft - pos1) + 'px';
    }

    function closeDragElement() {
      // stop moving when mouse button is released:
      document.onmouseup = null;
      document.onmousemove = null;
    }
  }

  disposed() {
    removeFromParent(this.element);
    super.disposed();
  }
}

export class Network {
  settings: NetworkPrefs = {
    host: 'wss://seungissues-wbsimp-test3.herokuapp.com/',
    user: JSON.parse(localStorage.getItem('wbsUser') || '{"id": -1, "chan": {0: true}}'),
    syncables: {},
    syncChan: '0'
  };
  chatWindow: NetworkChatWidget;
  ws: WebSocket;
  netButton: HTMLDivElement;
  lastRemoteStateString: string;
  lastLocalStateString: string;
  lastSentStateString: string;

  stateFromUrl =
      () => {
        const rawState = window.location.hash;
        return JSON.parse(decodeURIComponent(rawState).substring(2));
      }

  constructor(public viewer: Viewer) {
    // super();
    this.chatWindow = new NetworkChatWidget(this);
    document.body.appendChild(this.chatWindow.element);

    const net = this;
    const repState = window.history.replaceState.bind(window.history);
    const stateChangeHandler = () => {
      if (net.ws && net.ws.readyState === net.ws.OPEN && net.settings.syncChan !== '0') {
        // Do not send state if it was from remote
        const state = this.viewer.state.toJSON();
        const stateString = JSON.stringify(state);
        if (stateString !== net.lastRemoteStateString && stateString !== net.lastSentStateString) {
          net.lastSentStateString = stateString;
          net.ws.send(JSON.stringify({method: 'state', state}));
        }
      }
    };
    window.history.replaceState = (...args) => {
      repState.apply(window.history, args);
      stateChangeHandler();
    };

    this.chatWindow.input.addEventListener('keyup', (e) => {
      if (e.code === 'Enter' && this.ws) {
        const {input} = this.chatWindow;
        let message: string|string[] = input.value;
        let method;
        let chan = this.chatWindow.activeCh.value;
        if (message.length && message[0] === '\\') {
          message = message.split('');
          const cmdend = message.indexOf(' ');
          if (cmdend > -1) {
            method = message.splice(0, message.indexOf(' '));
            message.shift();
            message = message.join('');
          } else {
            method = message;
            message = '';
          }
          method.shift();
          method = method.join('');
        }
        this.ws.send(JSON.stringify({message, method, chan}));
        input.value = '';
      }
    });
  }

  config() {
    new NetworkConfiguration(this.viewer, this);
  }

  nethelp() {
    new NetworkHelp(this.viewer, this);
  }

  notifyToggle() {}

  searchDialog() {
    new NetworkSearch(this.viewer, this);
  }

  query() {
    if (this.ws) {
      this.ws.send(
          JSON.stringify({message: this.settings.user.chan, method: 'query', divert: true}));
    }
  }

  channel(message: string, join: boolean) {
    if (this.ws) {
      this.ws.send(JSON.stringify({message, method: (join) ? 'channel' : 'leave'}));
    }
  }


  nickname() {
    if (this.ws) {
      this.ws.send(JSON.stringify({message: this.settings.user.name, method: 'name'}));
    }
  }

  diff(a: string, b: string) {
    let arr = a.split('');
    let brr = b.split('');
    let crr = [];
    let Arr = (a.length >= b.length) ? arr : brr;
    let Brr = (a.length === Arr.length) ? brr : arr;

    for (var i = 0; i < Brr.length; i++) {
      if (Arr[i] !== Brr[i]) {
        crr.push(Arr[i]);
      }
    }
    if (i < Arr.length) {
      crr = [...crr, ...Arr.splice(i)];
    }
    return crr.join('');
  }

  filter(state: any) {
    const filter = this.settings.syncables;
    return {...state, ...filter};
  }

  connect() {
    if (this.settings.host !== '') {
      this.netButton.classList.add('neuroglancer-net-status-pending');
      this.ws = new WebSocket(this.settings.host);
      const ws = this.ws;
      const id = this.settings.user.id;
      const connectBtn = <HTMLInputElement>document.getElementById('net-connect-button');
      if (connectBtn) {
        connectBtn.disabled = true;
      }

      ws.addEventListener('close', () => {
        const status = this.netButton.classList;
        status.remove('neuroglancer-net-status-connected');
        if (connectBtn) {
          connectBtn.disabled = false;
        }
      });

      ws.addEventListener('open', () => {
        const status = this.netButton.classList;
        status.remove('neuroglancer-net-status-pending');
        status.add('neuroglancer-net-status-connected');
        if (this.settings.user.id === -1) {
          delete this.settings.user.id;
        }
        ws.send(JSON.stringify({method: 'init', user: this.settings.user}));
      });

      ws.addEventListener('message', (pack) => {
        const data = JSON.parse(pack.data);
        if (data.state) {
          // state negotiation
          if (data.user.id !== id) {
            // ignore own state change
            const safeState = this.filter(data.state);
            this.lastLocalStateString =
                JSON.stringify(this.viewer.state.toJSON());  // JSON.stringify(this.stateFromUrl());
            this.lastRemoteStateString = JSON.stringify(safeState);
            this.viewer.state.restoreState(safeState);
          }
        } else if (data.heartbeat) {
        } else {
          this.chatWindow.viewport.textContent += `\n${data.message || data.server}`;
          this.chatWindow.viewport.scrollTop = this.chatWindow.viewport.scrollHeight;
          if (data.server && data.user) {
            this.settings.user = data.user;
            localStorage.setItem('wbsUser', JSON.stringify(this.settings.user));
          }
        }
      });

      ws.addEventListener('close', () => {
        const status = this.netButton.classList;
        status.remove('neuroglancer-net-status-connected');
        status.remove('neuroglancer-net-status-pending');
        this.chatWindow.viewport.textContent += `\nDisconnected!`;
        delete (this.ws);
      });
    }
  }

  createNetworkButton() {
    this.netButton = makeTextIconButton('🔁', 'Connect');
    this.viewer.registerEventListener(this.netButton, 'click', async () => {
      const shown = this.chatWindow.element.style.display !== 'none';
      this.chatWindow.element.style.display = shown ? 'none' : 'block';
    });
    const autoConnect = getAutoConnect().value;
    if (autoConnect) {
      this.connect();
    }
    return this.netButton;
  }
}
