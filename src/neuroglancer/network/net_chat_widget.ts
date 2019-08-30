import {RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';
import {makeTextIconButton} from 'neuroglancer/widget/text_icon_button';
import { Network } from 'neuroglancer/network/net_widget';

export class NetworkChatWidget extends RefCounted {
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
      activeCh.append(...net.genOptions());
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
