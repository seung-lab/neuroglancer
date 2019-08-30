import {InputConfig, Network} from 'neuroglancer/network/net_widget';
import {Overlay} from 'neuroglancer/overlay';
import {Viewer} from 'neuroglancer/viewer';

export abstract class NetworkOverlay extends Overlay {
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
