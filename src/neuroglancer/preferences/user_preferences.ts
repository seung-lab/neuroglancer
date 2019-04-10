import {Overlay} from 'neuroglancer/overlay';
import {Viewer} from 'neuroglancer/viewer';
import {TrackableBoolean, TrackableBooleanCheckbox} from 'neuroglancer/trackable_boolean';


require('./user_preferences.css');

export class UserPreferencesDialog extends Overlay {
  constructor(public viewer: Viewer) {
    super();

    let {content} = this;
    content.classList.add('user-preferences');

    let scroll = document.createElement('div');
    scroll.classList.add('user-preferences-container');

    content.appendChild(scroll);

    const addCheckbox = (label: string, value: TrackableBoolean) => {
      const labelElement = document.createElement('label');
      labelElement.textContent = label;
      const checkbox = this.registerDisposer(new TrackableBooleanCheckbox(value));
      labelElement.appendChild(checkbox.element);
      scroll.appendChild(labelElement);
    };

    let header = document.createElement('h2');
    header.textContent = 'Preferences';
    scroll.appendChild(header);
    let dl = document.createElement('div');
    dl.className = 'dl';
    scroll.appendChild(dl);

    addCheckbox('Test checkbox', viewer.showAxisLines);

    let container = document.createElement('div');
    let container2 = document.createElement('div');
    container2.className = 'definition-outer-container';
    container.className = 'definition-container';
    let dt = document.createElement('div');
    dt.className = 'dt';
    dt.textContent = 'hI THERE';
    let dd = document.createElement('div');
    dd.className = 'dd';
    dd.textContent = 'action';
    container.appendChild(dt);
    container.appendChild(dd);
    dl.appendChild(container2);
    container2.appendChild(container);
  }
}

