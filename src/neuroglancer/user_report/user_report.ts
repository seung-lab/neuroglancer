import axios from 'axios';
import validator from 'validator';
import {Overlay} from 'neuroglancer/overlay';
import {Viewer} from 'neuroglancer/viewer';

// TODO: Clean up
// TODO: css
// require('./user_report.css');

interface LooseObject {
  [key: string]: any;
}
export class UserReportDialog extends Overlay {
  constructor(public viewer: Viewer, img: string = '') {
    super();
    let {content} = this;
    this.image = img;

    let modal = document.createElement('div');

    content.appendChild(modal);

    let header = document.createElement('h3');
    header.textContent = 'Complaint Box';
    modal.appendChild(header);

    const br = () => document.createElement('br');
    const labelWrap = (label: string, element?: (HTMLElement|string)[]) => {
        const labelElement = document.createElement('label');

        labelElement.textContent = label;
        if (element) { element.map(e => labelElement.append(e)); }
        modal.appendChild(labelElement);
        modal.appendChild(br());
        modal.appendChild(br());
    };
    interface InputConfig {
      placeholder?: string;
      required?: boolean;
      onblur?: ((this: GlobalEventHandlers, ev: FocusEvent) => any) | null;
      type?: string;

    }
    const simpleInput = (label: string, id: string, config?: InputConfig) => {
        const textbox = document.createElement('input');
        let req = document.createElement('span');

        textbox.id = id;
        if (config) {
          textbox.placeholder = config.placeholder || '';
          if (config.required) {
            req.textContent = '*';
            req.style.color =' red';
            textbox.setAttribute('required', '');
            this.complete[label] = false;
          }
          if (config.onblur) { textbox.onblur = config.onblur; }
        }
        textbox.onfocus = () => textbox.setAttribute('oldVal', textbox.value);
        textbox.setAttribute('sName', label);
        textbox.type = 'text';
        labelWrap(label, [req, ' ', textbox]);
    };
    const giveSimpleCheck = (value: string, id?: string, className?: string) => {
        const chkbox = document.createElement('input');

        if (id) { chkbox.id = id; }
        if (className) { chkbox.className += className; }
        chkbox.value = value;
        chkbox.type = 'checkbox';

        return chkbox;
    };
    const unDisable = () => {
      // let submit = document.querySelector('#complain');

      if (submit) {
        if (Object.values(this.complete).every(b => b)) {
          submit.disabled = false;
        }
        else {
          submit.disabled = true;
        }
      }
    };
    const isASP = (s: string, numeric: boolean) => {
      let reg = numeric ? /[a-zA-Z\d][a-zA-Z\d .'&]+/g : /[a-zA-Z][a-zA-Z .']+/g;
      let match = s.match(reg);

      if (match) { return match[0] === s; }
      return false;
    };
    const genericBlur = (e: Event) => {
      let self: HTMLInputElement = <HTMLInputElement>e.target;
      let label = self.getAttribute('sName') || '';
      self.value = self.value.trim();
      let valid =isASP(self.value, label === 'Title');

      if (valid) { this.complete[label] = true; }
      else if (validator.isEmpty(self.value, { ignore_whitespace: true})) { this.complete[label] = false; }
      else { self.value = self.getAttribute('oldVal') || ''; }

      unDisable();
    };

    simpleInput('Name', 'form_name', { required: true, onblur: genericBlur});
    simpleInput('Email', 'form_email', { onblur: (e: Event) => {
      let self: HTMLInputElement = <HTMLInputElement>e.target;
      let valid = validator.isEmpty(self.value) || validator.isEmail(self.value);
      let normal = self.value.length ? validator.normalizeEmail(self.value) || '' : '';

      if (valid) { self.value = normal; }
      else { self.value = self.getAttribute('oldVal') || ''; }
    }});

    labelWrap('Issue Type', [
      br(),
      giveSimpleCheck('1', void(0), 'form_type'), ' Bug ',
      giveSimpleCheck('2', void(0), 'form_type'), ' Suggestion'
    ]);

    simpleInput('Title', 'form_title', { required: true, onblur: genericBlur});

    let
      description = document.createElement('textarea'),
      asterick = document.createElement('span');
    description.id = 'form_des';
    description.placeholder = `Well, we're waiting...`;
    description.setAttribute('required', '');
    description.onblur = (e: Event) => {
      let self: HTMLInputElement = <HTMLInputElement>e.target;
      let valid = !validator.isEmpty(self.value);

      if (valid) { this.complete['description'] = true; }
      else { this.complete['description'] = false; }

      unDisable();
    };
    description.rows = 5;
    description.cols = 40;
    asterick.textContent = '*';
    asterick.style.color =' red';
    this.complete.description = false;
    labelWrap('Description', [asterick, br(), description]);

    labelWrap('Extra Data', [
      br(),
      giveSimpleCheck('', 'form_shot'), ' Submit Screenshot', br(),
      giveSimpleCheck('', 'form_surl'), ' Submit Url Address', br()
    ]);

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
    let
        url = `https://script.google.com/macros/s/AKfycbzmPIJMb9z_o0_2vFdNeTIgrur_b_2tFO2A3pP9w9r7RVzub5E/exec`,
        img = <HTMLInputElement> document.querySelector('#form_shot'),
        image = (img && img.checked) ? this.image : '',
        headers = {
            'Content-Type': 'text/plain;charset=utf-8',
        },
        data = JSON.stringify({
            name: (<HTMLInputElement>document.querySelector('#form_name')).value,
            email: (<HTMLInputElement>document.querySelector('#form_email')).value,
            type: Array.from(document.querySelectorAll('.form_type')).map(
                e => parseInt((<HTMLInputElement>e).value, 10) * Number((<HTMLInputElement>e).checked)
            ).reduce((a, c) => a + c),
            // TODO: drop validator?
            des: validator.escape((<HTMLInputElement>document.querySelector('#form_des')).value),
            title: (<HTMLInputElement>document.querySelector('#form_title')).value,
            image,
            surl: (<HTMLInputElement>document.querySelector('#form_surl')).checked ? window.location.href : 0
        });

    this.dispose();

    try {
      await axios({
        method: 'post',
        headers,
        url,
        data
      });
      alert('Right into the complaint box!');
    }
    catch (e) {
      alert('Ruh roh :(\n' + e);
      throw(e);
    }
  }
}
