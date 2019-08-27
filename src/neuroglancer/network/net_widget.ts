import {Overlay} from 'neuroglancer/overlay';
import {TrackableValue} from 'neuroglancer/trackable_value';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';
import {Viewer} from 'neuroglancer/viewer';
import {makeTextIconButton} from 'neuroglancer/widget/text_icon_button';

require('./net_widget.css');

interface User {
  id: number;
  channel: number;
  name?: TrackableValue<string>;
}
interface ItemConfig {
  type?: string;
  id?: string;
  className?: string;
}
const br = () => document.createElement('br');
class NetworkPrefs extends Overlay {
  host: string;
  user: User;

  constructor(public viewer: Viewer, connect: Function) {
    super();
    let {content} = this;

    const labelWrap = (label: string, element?: (HTMLElement|string)[]) => {
      const labelElement = document.createElement('label');

      labelElement.textContent = label;
      if (element) {
        element.map(e => labelElement.append(e));
      }
      modal.appendChild(labelElement);
      modal.appendChild(br());
      modal.appendChild(br());
    };

    const simpleInput = (label: string, id: string, element?: (HTMLElement|string)[]) => {
      const textbox = document.createElement('input');

      textbox.id = id;
      textbox.type = 'text';
      labelWrap(label, [' ', textbox, ...(element ? element : [])]);
    };

    const simpleItem =
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
        };

    let modal = document.createElement('div');
    content.appendChild(modal);
    let header = document.createElement('h3');
    header.textContent = 'Network Configuration';
    modal.appendChild(header);

    const connectBtn = document.createElement('button');
    connectBtn.innerHTML = 'Connect';
    connectBtn.addEventListener('click', () => {
      const host = <HTMLInputElement>document.getElementById('net-hostaddr');
      this.host = host.value;
      connect();
    });
    simpleInput('Host', 'net-hostaddr', [connectBtn]);
    const applyBtn = document.createElement('button');
    applyBtn.innerHTML = 'Apply Changes';
    applyBtn.addEventListener('click', () => {
    });
    modal.appendChild(applyBtn);
    modal.appendChild(br());
    simpleInput('Channel ID', 'net-cid');
    simpleInput('Nickname', 'net-nick');

    let issueTypeConfig = {type: 'checkbox', className: 'form_type'};
    labelWrap('Sync Settings', [
      br(), simpleItem('1', issueTypeConfig), ' Bug ', simpleItem('2', issueTypeConfig),
      ' Suggestion'
    ]);
  }

  open() {
    throw new Error('Method not implemented.');
  }

  apply() {
    throw new Error('Method not implemented.');
  }
}

class NetworkChatWidget extends RefCounted {
  element = document.createElement('div');
  header = document.createElement('div');
  input = <HTMLInputElement>document.createElement('input');
  viewport = <HTMLTextAreaElement>document.createElement('textarea');

  constructor(private prefs: NetworkPrefs) {
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
      this.prefs.open();
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
  preferences: NetworkPrefs;
  chatWindow: NetworkChatWidget;
  ws: WebSocket;
  netButton: HTMLDivElement;

  constructor(public viewer: Viewer) {
    // super();
    this.preferences = new NetworkPrefs(viewer, this.connect);
    this.chatWindow = new NetworkChatWidget(this.preferences);

    this.chatWindow.input.addEventListener('keyup', (e) => {
      if (e.code === 'Enter' && this.ws) {
        const {input} = this.chatWindow;
        let message: string|string[] = input.value;
        let method;
        if (message.length && message[0] === '\\') {
          message = message.split('');
          method = message.splice(0, message.indexOf(' '));
          message.shift();
          method.shift();
          method = method.join('');
          message = message.join('');
        }
        this.ws.send(JSON.stringify({message, method}));
        input.value = '';
      }
    });
  }

  connect() {
    if (this.preferences.host) {
      this.netButton.classList.add('neuroglancer-net-status-pending');
      this.ws = new WebSocket(this.preferences.host);
      const ws = this.ws;

      ws.addEventListener('open', () => {
        const raw = localStorage.getItem('wbsUser');
        this.preferences.user = raw ? JSON.parse(raw) : void (0);
        ws.send(JSON.stringify({method: 'init', user: this.preferences.user}));
      });

      ws.addEventListener('message', (pack) => {
        const status = this.netButton.classList;
        if (status.contains('neuroglancer-net-status-pending')) {
          status.remove('neuroglancer-status-pending');
          status.add('neuroglancer-status-connected');
        }
        const data = JSON.parse(pack.data);
        if (data.state) {
          // state negotiation
        } else {
          this.chatWindow.viewport.textContent += `\n${data.message || data.server}`;
          if (data.server && data.user) {
            this.preferences.user = data.user;
            localStorage.setItem('wbsUser', JSON.stringify(this.preferences.user));
          }
        }
      });
    }
  }

  createNetworkButton() {
    this.netButton = makeTextIconButton('🔁', 'Connect');
    // button.classList.add('neuroglancer-net-status-pending');
    this.viewer.registerEventListener(this.netButton, 'click', async () => {
      const shown = this.chatWindow.element.style.display !== 'none';
      this.chatWindow.element.style.display = shown ? 'none' : 'block';
    });
    return this.netButton;
  }
}
