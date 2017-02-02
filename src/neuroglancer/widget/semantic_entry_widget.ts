
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';
import {Uint64} from 'neuroglancer/util/uint64';
import {Signal} from 'signals';

require('neuroglancer/noselect.css');
require('./semantic_entry_widget.css');

type ItemElement = HTMLButtonElement;


export class SemanticEntryWidget extends RefCounted {
  element = document.createElement('div');
  semanticApplied = new Signal();
  entered_list = Array();
  lastSemantic: string;
  form: any;
  input: any;
  label: any;
  ul: any;

  constructor() {
    super();
    let {element} = this;
    element.className = 'semantic-entry noselect';
    element.innerHTML = `
    <hr>
    Semantic classes
    <form>
      <label>
        + <input></input>
      </label>
    </form>
    <ul></ul>
    <hr>`;
    
    this.form = element.querySelector('form');
    this.label = element.querySelector('label');
    this.input = element.querySelector('input');
    this.ul = element.querySelector('ul');


    this.registerEventListener(this.form, 'submit', (event: Event) => {
      event.preventDefault();
      if (this.validateInput()) {
        this.input.classList.remove('valid-input', 'invalid-input');
        this.entered_list.push(this.input.value);
        this.updateUL()
        this.input.value = '';
      }
    });
    this.registerEventListener(this.form, 'input', () => {
      if (this.input.value === '') {
        this.input.classList.remove('valid-input', 'invalid-input');
        return;
      }
      if (this.validateInput()) {
        this.input.classList.remove('invalid-input');
      } else {
        this.input.classList.add('invalid-input');
      }
    });
  }

  updateUL() {
    //clear list 
    this.ul.innerHTML = '';
    let self = this;
    // Create the list element:
    for(var i = 0; i < this.entered_list.length; i++) {
        // Create the list item:
        var li = document.createElement('li');
        let button = document.createElement('button');
        li.appendChild(button)
        button.innerHTML = `${this.entered_list[i]}`
        button.addEventListener('click', function(this: ItemElement) {
          self.semanticApplied.dispatch(self.entered_list.indexOf(this.innerHTML));
          self.lastSemantic = this.innerHTML;
        });

        // Add it to the list:
        this.ul.appendChild(li);
    }

    // Finally, return the constructed list:
  }
  validateInput() { return true; }

  disposed() {
    removeFromParent(this.element);
    super.disposed();
  }
};
