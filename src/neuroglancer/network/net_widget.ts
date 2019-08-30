import {getAutoConnect} from 'neuroglancer/preferences/user_preferences';
import {Viewer} from 'neuroglancer/viewer';
import {makeTextIconButton} from 'neuroglancer/widget/text_icon_button';
import { NetworkConfiguration } from 'neuroglancer/network/net_config';
import { NetworkChatWidget } from 'neuroglancer/network/net_chat_widget';
import { NetworkHelp } from 'neuroglancer/network/net_help';
import { NetworkSearch } from 'neuroglancer/network/net_search';

require('./net_widget.css');

export interface User {
  id: number;
  chan: any;
  name?: string;
}

export interface InputConfig {
  id: string;
  classes?: string[];
  value?: string;
  disabled?: boolean;
  type?: string;
  checked?: boolean;
}

export interface NetworkPrefs {
  host: string;
  user: User;
  syncables: any;
  syncChan: string;
}

export const br = () => document.createElement('br');
export const brp = (e: HTMLElement) => [e, br(), br()];

export class Network {
  settings: NetworkPrefs = {
    host: 'wss://seungissues-wbsimp-test3.herokuapp.com/',
    user: JSON.parse(localStorage.getItem('wbsUser') || '{"id": -1, "chan": {"0": true}}'),
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

  genOptions() {
    const options = [];
    for (let chan in this.settings.user.chan) {
      const opt = document.createElement('option');
      opt.value = chan;
      opt.innerHTML = (chan === '0') ?  '0(All)' : chan;
      options.push(opt);
    }
    return options;
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
                JSON.stringify(this.viewer.state.toJSON());
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
            // rebuild the active channel select
            this.chatWindow.activeCh.innerHTML = '';
            this.chatWindow.activeCh.append(...this.genOptions());
            // TODO: Change to new channel, requires server sending back new channel
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
