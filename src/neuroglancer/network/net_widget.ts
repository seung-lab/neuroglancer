import {TrackableValue} from 'neuroglancer/trackable_value';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';
import {Overlay} from 'neuroglancer/overlay';
import {Viewer} from 'neuroglancer/viewer';
require('./whats_new.css');

export class NetworkPrefs extends Overlay {
    constructor(public viewer: Viewer) {
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
  
      const simpleInput = (label: string, id: string, config?: InputConfig) => {
        const textbox = document.createElement('input');
        let req = document.createElement('span');
  
        textbox.id = id;
        if (config) {
          textbox.placeholder = config.placeholder || '';
          if (config.required) {
            req.textContent = '*';
            req.style.color = ' red';
            textbox.setAttribute('required', '');
            this.complete[label] = false;
          }
          if (config.onblur) {
            textbox.onblur = config.onblur;
          }
        }
        textbox.onfocus = () => textbox.setAttribute('oldVal', textbox.value);
        textbox.setAttribute('sName', label);
        textbox.type = 'text';
        labelWrap(label, [req, ' ', textbox]);
      };
      const unDisable = () => {
        if (submit) {
          if (Object.values(this.complete).every(b => b)) {
            submit.disabled = false;
          } else {
            submit.disabled = true;
          }
        }
      };
      const genericBlur = (e: Event) => {
        let self: HTMLInputElement = <HTMLInputElement>e.target;
        let label = self.getAttribute('sName') || '';
        self.value = self.value.trim();
        let valid =
            (label === 'Title') ? isAlphaNumWithSpace(self.value) : isAlphaWithSpace(self.value);
  
        if (valid) {
          this.complete[label] = true;
        } else if (!self.value.length) {
          this.complete[label] = false;
        } else {
          self.value = self.getAttribute('oldVal') || '';
        }
        unDisable();
      };
  
      let modal = document.createElement('div');
      content.appendChild(modal);
      let header = document.createElement('h3');
      header.textContent = 'Send Feedback';
      modal.appendChild(header);
      let disclaimer = document.createElement('p');
      let warning = document.createElement('span');
      let reminder = document.createElement('span');
      warning.style.color = 'red';
      warning.innerText = `Do NOT post any sensitive information.\nThis report will be PUBLIC!`;
      disclaimer.appendChild(warning);
  
      let lastIssue = localStorage.getItem('lastIssue');
      if (lastIssue) {
        reminder.innerHTML =
            `Please do not post duplicate reports.<br>Your previous report is <a href='${
                lastIssue}'>here</a>.`;
        disclaimer.appendChild(br());
        disclaimer.appendChild(reminder);
      }
      modal.appendChild(disclaimer);
  
      simpleInput('Name', 'form_name', {required: true, onblur: genericBlur});
  
      let issueTypeConfig = {type: 'checkbox', className: 'form_type'};
      labelWrap('Issue Type', [
        br(), simpleItem('1', issueTypeConfig), ' Bug ', simpleItem('2', issueTypeConfig),
        ' Suggestion'
      ]);
  
      simpleInput('Title', 'form_title', {required: true, onblur: genericBlur});
  
      let description = document.createElement('textarea'), asterisk = document.createElement('span');
      description.id = 'form_des';
      description.placeholder = `Well, we're waiting...`;
      description.setAttribute('required', '');
      description.onblur = (e: Event) => {
        let self: HTMLInputElement = <HTMLInputElement>e.target;
        let valid = self.value.length;
  
        if (valid) {
          this.complete['description'] = true;
        } else {
          this.complete['description'] = false;
        }
        unDisable();
      };
      description.rows = 5;
      description.cols = 40;
      asterisk.textContent = '*';
      asterisk.style.color = ' red';
      this.complete.description = false;
      labelWrap('Description', [asterisk, br(), description]);
  
      // TODO: Auto detect environment, nice extra not really necessary
      let envTable = document.createElement('table');
      let osRow = genRow([
        'OS: ',
        simpleSelect(
            'form_os', [['Linux', 'Linux'], ['Mac OS X', 'Mac OS X'], ['Windows', 'Windows']])
      ]);
      let brwRow = genRow([
        'Browser: ',
        simpleSelect('form_brw', [['Chrome', 'Chrome'], ['Firefox', 'Firefox'], ['Safari', 'Safari']])
      ]);
      envTable.appendChild(osRow);
      envTable.appendChild(brwRow);
      labelWrap('Environment', [br(), envTable]);
  
      labelWrap('Extra Data', [
        br(), simpleItem('', {id: 'form_shot'}), ' Submit Screenshot', br(),
        simpleItem('', {id: 'form_surl'}), ' Submit Url Address', br()
      ]);
      if (!viewer.jsonStateServer.value) {
        (<HTMLInputElement>document.getElementById('form_surl')).disabled = true;
      }
      let submit = document.createElement('input');
      submit.id = 'complain';
      submit.type = 'submit';
      submit.disabled = true;
      submit.onclick = (e) => {
        if (!(<HTMLInputElement>e.target).disabled) {
          this.submit();
        }
      };
      modal.appendChild(submit);
    }
  
    image = '';
    complete: LooseObject = {};
    async submit() {
      let url =
              `https://script.google.com/macros/s/AKfycbzmPIJMb9z_o0_2vFdNeTIgrur_b_2tFO2A3pP9w9r7RVzub5E/exec`,
          img = <HTMLInputElement>document.querySelector('#form_shot'),
          image = (img && img.checked) ? this.image : '', headers = {
            'Content-Type': 'text/plain;charset=utf-8',
          },
          body = JSON.stringify({
            name: (<HTMLInputElement>document.querySelector('#form_name')).value,
            type: Array.from(document.querySelectorAll('.form_type'))
                      .map(
                          e => parseInt((<HTMLInputElement>e).value, 10) *
                              Number((<HTMLInputElement>e).checked))
                      .reduce((a, c) => a + c),
  
            des: encodeURIComponent((<HTMLInputElement>document.querySelector('#form_des')).value),
            title: (<HTMLInputElement>document.querySelector('#form_title')).value,
            image,
            os: (<HTMLInputElement>document.querySelector('#form_os')).value,
            brw: (<HTMLInputElement>document.querySelector('#form_brw')).value,
            surl: ((<HTMLInputElement>document.querySelector('#form_surl')).checked &&
                   this.viewer.jsonStateServer.value) ?
                window.location.href :
                0
          });
  
      this.dispose();
  
      try {
        let response = await fetch(url, {method: 'post', headers, body});
        let ghData = JSON.parse(await response.json());
        localStorage.setItem('lastIssue', ghData.html_url);
        alert(`Feedback received!\nYour report is posted here:\n${ghData.html_url}`);
      } catch (e) {
        alert('Ruh roh :(\n' + e);
        throw (e);
      }
    }
  }

export class NetworkChatWidget extends RefCounted {
  element = document.createElement('div');
  input = <HTMLInputElement>document.createElement('input');
  limit: TrackableValue<string>;
  model: TrackableValue<string>;

  constructor(
      private displayState: SegmentationUserLayerWithGraphDisplayState,
      private undo?: (message: string, action: string) => void) {
    super();
    this.model = displayState.timestamp;
    this.limit = displayState.timestampLimit;
    const {element, input, model} = this;
    const cancelButton = document.createElement('button');
    const nothingButton = document.createElement('button');
    nothingButton.textContent = '✔️';
    nothingButton.title =
        `Actually, this button doesn't do anything at all. Click anywhere to close the time select.`;
    element.classList.add('neuroglancer-time-widget');
    input.type = 'datetime-local';
    const maybeInitial = this.dateFormat(model.value);
    this.buildFlatpickr(input, (maybeInitial !== '') ? `${maybeInitial}Z` : void (0));
    this.limit.changed.add(() => this.buildFlatpickr(input, input.value));
    cancelButton.textContent = '❌';
    cancelButton.title = 'Reset Time';
    cancelButton.addEventListener('click', () => {
      this.revert(true);
      this.model.value = '';
    });
    element.appendChild(input);
    element.appendChild(nothingButton);
    element.appendChild(cancelButton);
    input.addEventListener('change', () => this.updateModel());
    this.registerDisposer(model.changed.add(() => this.updateView()));
  }
  private dateFormat(value: string) {
    if (value === '') {
      return '';
    }
    return ((new Date(parseInt(value, 10) * 1000)).toISOString()).slice(0, -1);
  }
  private revert(reset?: boolean) {
    if (this.undo) {
      this.undo(
          `${reset ? 'Resetting' : 'Enabling'} Timestamp deselects selected segments.`, 'Undo?');
    }
  }

  private updateView() {
    const formatted = this.dateFormat(this.model.value);
    const inputFormatted = new Date(this.input.value).toISOString().slice(0, -1);
    if (formatted !== inputFormatted || this.input.value === '') {
      this.input.value = this.dateFormat(this.model.value);
      this.updateModel(true);
    }
  }
  private updateModel(view?: boolean) {
    this.displayState.rootSegments.clear();
    this.displayState.hiddenRootSegments!.clear();
    if (!view) {
      this.revert();
      this.model.restoreState(this.input.value);
    }
  }

  private buildFlatpickr(ele: HTMLInputElement, defaultDate?: string|Date) {
    return flatpickr(ele, {
      defaultDate,
      enableTime: true,
      enableSeconds: true,
      'disable': [(date) => {
        const target = date.valueOf();
        const future = Date.now();
        // note: this is fine b/c we are dealing with epoch time (date sheNaNigans are irrelevant
        // here)
        const past = parseInt(this.limit.value || '0', 10) - (24 * 60 * 60 * 1000);

        if (past) {
          return past > target || target >= future;
        } else {
          return target >= future;
        }
      }],
      plugins: [minMaxTimePlugin({
        getTimeLimits: (date) => {
          const now = new Date();
          const past = new Date(parseInt(this.limit.value || '0', 10));
          let minmax = {minTime: `00:00:00`, maxTime: `23:59:59`};

          if (date.toDateString() === now.toDateString()) {
            minmax.maxTime = `${now.getHours()}:${now.getMinutes()}:${now.getSeconds()}`;
          } else if (date.toDateString() === past.toDateString()) {
            // Flatpickr does not support millisecond res, must round up to nearest second
            // TODO: Seconds fixed has been merged in, remove + 1 to minutes when flatpickr is
            // updated
            minmax.minTime = `${past.getHours()}:${(past.getMinutes() + 1) % 60}:${
                (past.getSeconds() + 1) % 60}`;
          }
          return minmax;
        }
      })]
    });
  }

  disposed() {
    removeFromParent(this.element);
    super.disposed();
  }
}