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
  chan: Object;
  name?: string;
}
/*interface ItemConfig {
  type?: string;
  id?: string;
  className?: string;
}*/

interface NetworkPrefs {
  host: string;
  user: User;
  syncables: Object;
}

const br = () => document.createElement('br');
class NetworkConfiguration extends Overlay {
  constructor(public viewer: Viewer, public net: Network) {
    super();
    let {content} = this;

    const labelWrap = (label: string, element?: (HTMLElement|string)[], id?: string, ret?: boolean) => {
      const labelElement = document.createElement('label');
      if (id) {
        labelElement.id = id;
      }

      labelElement.textContent = label;
      if (element) {
        element.map(e => labelElement.append(e));
      }
      if (ret) {
        return labelElement;
      } else {
        modal.appendChild(labelElement);
        modal.appendChild(br());
        modal.appendChild(br());
        return;
      }
    };

    const simpleInput = (label: string, id: string, element?: (HTMLElement|string)[]) => {
      const textbox = document.createElement('input');

      textbox.id = id;
      textbox.type = 'text';
      labelWrap(label, [' ', textbox, ...(element ? element : [])]);
    };

    const simpleInputReal = (label: string, id: string, element?: (HTMLElement|string)[]) => {
      const textbox = document.createElement('input');

      textbox.id = id;
      textbox.type = 'text';
      return <HTMLLabelElement> labelWrap(label, [' ', textbox, ...(element ? element : [])], void(0), true);
    };

    /*const simpleItem =
        (value: string, config: ItemConfig = {type: 'checkbox'}, checked?: boolean) => {
          const chkbox = document.createElement('input');
          const {id, className, type} = config;

          if (id) {
            chkbox.id = id;
          }
          if (className) {
            chkbox.className += className;
          }
          chkbox.value = value;
          chkbox.type = type || 'checkbox';

          if (type === 'radio') {
            chkbox.name = className || id || '';
          }

          if (checked) {
            chkbox.checked = true;
          }

          return chkbox;
        };*/

    let modal = document.createElement('div');
    content.appendChild(modal);
    let header = document.createElement('h3');
    header.textContent = 'Network Configuration';
    modal.appendChild(header);

    const connectBtn = document.createElement('button');
    connectBtn.id = 'net-connect-button';
    connectBtn.innerHTML = 'Connect';
    connectBtn.addEventListener('click', () => {
      const host = <HTMLInputElement>document.getElementById('net-hostaddr');
      net.settings.host = host.value;
      net.connect();
    });
    simpleInput('ID', 'net-uid');
    simpleInput('Host', 'net-hostaddr', [' ', connectBtn]);
    const applyBtn = document.createElement('button');
    applyBtn.innerHTML = 'Apply Changes';
    applyBtn.addEventListener('click', () => this.apply());
    modal.appendChild(applyBtn);
    modal.appendChild(br());
    modal.appendChild(br());
    simpleInput('Nickname', 'net-nick');
    const addChan = () => {
      const textbox = document.createElement('input');
      textbox.classList.add('net-cid');
      textbox.type = 'text';
      return textbox;
    };
    const newChannel = document.createElement('button');
    //Function to create new row of channel with - button except for the first one
    newChannel.id = 'net-addchannel-button';
    newChannel.innerHTML = '+';
    newChannel.addEventListener('click', () => {
      const host = <HTMLInputElement>document.getElementById('net-hostaddr');
      net.settings.host = host.value;
      net.connect();
    });
    const channelArr = [];
    //loop channel add
    labelWrap('Channels', [br(), simpleInputReal('', 'net-cid-0')]);

    // let issueTypeConfig = {type: 'checkbox', className: 'form_type'};
    labelWrap('Sync Settings', [
      /*br(), simpleItem('1', issueTypeConfig), ' Bug ', simpleItem('2', issueTypeConfig),
      ' Suggestion'*/
    ]);

    const uid = (<HTMLInputElement>document.getElementById('net-uid')!);
    uid.disabled = true;
    uid.value = net.settings.user.id.toString();
    (<HTMLInputElement>document.getElementById('net-hostaddr')!).value = net.settings.host;
    (<HTMLInputElement>document.getElementById('net-cid')!).value =
        net.settings.user.chan.toString();
    (<HTMLInputElement>document.getElementById('net-nick')!).value = net.settings.user.name || '';
  }

  apply() {
    const opts = {
      cid: (<HTMLInputElement>document.getElementById('net-cid')!).value,
      nick: (<HTMLInputElement>document.getElementById('net-nick')!).value
    };

    if (opts.cid !== '' && parseInt(opts.cid, 10) !== this.net.settings.user.chan) {
      this.net.settings.user.chan = parseInt(opts.cid, 10);
      this.net.channel();
    }

    if (opts.nick !== '' && opts.nick !== this.net.settings.user.name) {
      this.net.settings.user.name = opts.nick;
      this.net.nickname();
    }
  }
}

class NetworkChatWidget extends RefCounted {
  element = document.createElement('div');
  header = document.createElement('div');
  input = <HTMLInputElement>document.createElement('input');
  viewport = <HTMLTextAreaElement>document.createElement('textarea');

  constructor(net: Network) {
    super();

    const {element, header, input, viewport} = this;
    element.className = 'neuroglancer-net-chatWindow';
    header.className = 'neuroglancer-net-chatHeader';
    viewport.className = 'neuroglancer-net-display';
    viewport.disabled = true;
    viewport.rows = 5;
    viewport.cols = 40;
    input.className = 'neuroglancer-net-input';
    input.type = 'text';

    const config = makeTextIconButton('⚙', 'Net Config');
    this.registerEventListener(config, 'click', () => {
      net.open();
    });
    header.appendChild(config);
    element.appendChild(header);
    element.appendChild(viewport);
    element.appendChild(document.createElement('br'));
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
    user: JSON.parse(localStorage.getItem('wbsUser') || '{"id": -1, "chan": 0}'),
    syncables: {}
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
      if (net.ws && net.ws.readyState === net.ws.OPEN) {
        // Do not send state if it was from remote
        const state = this.viewer.state.toJSON();  // this.stateFromUrl();
        const stateString = JSON.stringify(state);
        if (stateString !==
                net.lastRemoteStateString /*&& stateString !== net.lastLocalStateString*/
            && stateString !== net.lastSentStateString) {
          // console.log(this.diff(stateString, net.lastRemoteStateString || ''));
          net.lastSentStateString = stateString;
          net.ws.send(JSON.stringify({method: 'state', state}));
        }
      }
    };
    window.history.replaceState = (...args) => {
      repState.apply(window.history, args);
      stateChangeHandler();
    };
    // this.viewer.state.changed.add(stateChangeHandler);

    this.chatWindow.input.addEventListener('keyup', (e) => {
      if (e.code === 'Enter' && this.ws) {
        const {input} = this.chatWindow;
        let message: string|string[] = input.value;
        let method;
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
        this.ws.send(JSON.stringify({message, method}));
        input.value = '';
      }
    });
  }

  open() {
    new NetworkConfiguration(this.viewer, this);
  }

  channel() {
    if (this.ws) {
      this.ws.send(JSON.stringify({message: this.settings.user.chan, method: 'channel'}));
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
